from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pymongo import MongoClient
from bson.objectid import ObjectId
import os
from dotenv import load_dotenv
import subprocess
import threading
import signal
import time
import shutil
from werkzeug.utils import secure_filename
try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    _HAS_BOTO3 = True
except Exception:
    boto3 = None
    BotoCoreError = Exception
    ClientError = Exception
    _HAS_BOTO3 = False
try:
    from PIL import Image
    _HAS_PIL = True
except Exception:
    Image = None
    _HAS_PIL = False
from io import BytesIO

load_dotenv()

MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017')
DB_NAME = os.getenv('DB_NAME', 'rtsp_overlay_demo')
HLS_FOLDER = os.getenv('HLS_FOLDER', 'static/hls')
UPLOAD_FOLDER = os.getenv('UPLOAD_FOLDER', 'static/uploads')
# Allowed image mime types and max upload size (bytes)
ALLOWED_IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
MAX_UPLOAD_SIZE = int(os.getenv('MAX_UPLOAD_SIZE', 5 * 1024 * 1024))  # 5 MB default
S3_BUCKET = os.getenv('S3_BUCKET')
S3_REGION = os.getenv('S3_REGION')
PRESIGNED_URL_EXPIRES = int(os.getenv('PRESIGNED_URL_EXPIRES', 3600))
MAX_IMAGE_WIDTH = int(os.getenv('MAX_IMAGE_WIDTH', 1920))
MAX_IMAGE_HEIGHT = int(os.getenv('MAX_IMAGE_HEIGHT', 1080))
AUTO_RESIZE_IMAGES = os.getenv('AUTO_RESIZE_IMAGES', 'false').lower() in ('1','true','yes')
DEV_NO_DB = os.getenv('DEV_NO_DB', 'false').lower() in ('1','true','yes')

client = None
db = None
overlays = None
# In-memory store used when DEV_NO_DB is enabled or DB is not available
in_memory_overlays = []
try:
    # give a short timeout for initial selection
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    # try to ping to force connection or raise
    client.admin.command('ping')
    db = client[DB_NAME]
    overlays = db.overlays
    try:
        overlays.create_index('created_at')
    except Exception:
        pass
except Exception as e:
    print('Warning: could not connect to MongoDB:', e)
    client = None
    db = None
    overlays = None
try:
    # ensure a created_at index for overlays
    overlays.create_index('created_at')
except Exception:
    pass


def ensure_db():
    """Try to (re)initialize MongoDB client, db, and overlays collection.
    Safe to call multiple times; returns True if overlays is ready.
    """
    global client, db, overlays
    if overlays is not None:
        return True
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        client.admin.command('ping')
        db = client[DB_NAME]
        overlays = db.overlays
        try:
            overlays.create_index('created_at')
        except Exception:
            pass
        print('Connected to MongoDB (ensure_db)')
        return True
    except Exception as e:
        print('ensure_db: could not connect to MongoDB:', e)
        client = None
        db = None
        overlays = None
        if DEV_NO_DB:
            print('DEV_NO_DB enabled: falling back to in-memory overlays')
            return True
        return False

app = Flask(__name__, static_folder='../frontend/build', static_url_path='/')
CORS(app)

# Ensure HLS folder exists
os.makedirs(HLS_FOLDER, exist_ok=True)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Manage ffmpeg process for streaming
ffmpeg_proc = None
ffmpeg_lock = threading.Lock()

@app.route('/api/overlays', methods=['GET'])
def list_overlays():
    if DEV_NO_DB or overlays is None:
        return jsonify(in_memory_overlays), 200
    if not ensure_db():
        return jsonify({'error': 'db_not_connected'}), 500
    docs = []
    for d in overlays.find():
        d['_id'] = str(d['_id'])
        docs.append(d)
    return jsonify(docs), 200

@app.route('/api/overlays', methods=['POST'])
def create_overlay():
    payload = request.json
    # basic validation
    payload.setdefault('x', 0)
    payload.setdefault('y', 0)
    payload.setdefault('width', 100)
    payload.setdefault('height', 50)
    payload.setdefault('content', '')
    payload.setdefault('type', 'text')
    payload.setdefault('created_at', time.time())
    if DEV_NO_DB or overlays is None:
        # create a simple in-memory id
        payload['_id'] = str(int(time.time() * 1000))
        in_memory_overlays.append(payload)
        return jsonify(payload), 201
    if not ensure_db():
        return jsonify({'error': 'db_not_connected'}), 500
    res = overlays.insert_one(payload)
    payload['_id'] = str(res.inserted_id)
    return jsonify(payload), 201

@app.route('/api/overlays/<id>', methods=['PUT'])
def update_overlay(id):
    payload = request.json
    _id = ObjectId(id)
    if DEV_NO_DB or overlays is None:
        for i, o in enumerate(in_memory_overlays):
            if o.get('_id') == id:
                in_memory_overlays[i] = {**o, **payload, '_id': id}
                return jsonify(in_memory_overlays[i]), 200
        return jsonify({'error': 'not_found'}), 404
    if not ensure_db():
        return jsonify({'error': 'db_not_connected'}), 500
    overlays.update_one({'_id': _id}, {'$set': payload})
    doc = overlays.find_one({'_id': _id})
    doc['_id'] = str(doc['_id'])
    return jsonify(doc), 200

@app.route('/api/overlays/<id>', methods=['DELETE'])
def delete_overlay(id):
    _id = ObjectId(id)
    if DEV_NO_DB or overlays is None:
        for i, o in enumerate(in_memory_overlays):
            if o.get('_id') == id:
                in_memory_overlays.pop(i)
                return '', 204
        return jsonify({'error': 'not_found'}), 404
    if not ensure_db():
        return jsonify({'error': 'db_not_connected'}), 500
    overlays.delete_one({'_id': _id})
    return '', 204

# Serve HLS files (so ffmpeg output in static/hls is accessible)
@app.route('/hls/<path:filename>')
def hls_files(filename):
    return send_from_directory(HLS_FOLDER, filename, conditional=True)


@app.route('/uploads/<path:filename>')
def uploads_files(filename):
    return send_from_directory(UPLOAD_FOLDER, filename, conditional=True)


@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Upload a file (logo/image) and return a URL to access it.

    Expects multipart/form-data with field 'file'.
    Returns: { url: '/uploads/<filename>' }
    """
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'no_file'}), 400
        f = request.files['file']
        if f.filename == '':
            return jsonify({'error': 'empty_filename'}), 400
        filename = secure_filename(f.filename)

        # read raw bytes from the incoming stream
        f.stream.seek(0)
        file_bytes = f.stream.read()
        size = len(file_bytes)
        if size > MAX_UPLOAD_SIZE:
            return jsonify({'error': 'file_too_large', 'size': size, 'max': MAX_UPLOAD_SIZE}), 400

        # basic mime-type validation using provided mimetype
        mimetype = f.mimetype or ''
        if mimetype not in ALLOWED_IMAGE_MIMES:
            return jsonify({'error': 'invalid_mimetype', 'mimetype': mimetype}), 400

        # prefix with timestamp to reduce collisions
        stamp = str(int(time.time() * 1000))
        filename = f"{stamp}-{filename}"

        # default: use the original bytes unless we resize
        img_bytes = file_bytes
        out_content_type = mimetype

        if _HAS_PIL:
            try:
                img = Image.open(BytesIO(file_bytes))
                width, height = img.size
                if width > MAX_IMAGE_WIDTH or height > MAX_IMAGE_HEIGHT:
                    if AUTO_RESIZE_IMAGES:
                        ratio = min(MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height)
                        new_w = int(width * ratio)
                        new_h = int(height * ratio)
                        img = img.convert('RGBA') if img.mode in ('RGBA', 'LA') else img.convert('RGB')
                        img = img.resize((new_w, new_h), Image.ANTIALIAS)
                        buf = BytesIO()
                        # choose output format
                        fmt = 'JPEG' if img.mode == 'RGB' else 'PNG'
                        img.save(buf, format=fmt)
                        buf.seek(0)
                        img_bytes = buf.read()
                        out_content_type = 'image/jpeg' if fmt == 'JPEG' else 'image/png'
                    else:
                        return jsonify({'error': 'image_dimensions_exceeded', 'width': width, 'height': height, 'max_w': MAX_IMAGE_WIDTH, 'max_h': MAX_IMAGE_HEIGHT}), 400
            except Exception as e:
                app.logger.exception('invalid image')
                return jsonify({'error': 'invalid_image', 'detail': str(e)}), 400
        else:
            app.logger.debug('Pillow not installed; skipping dimension checks')

    except Exception as e:
        app.logger.exception('upload processing failed')
        return jsonify({'error': 'upload_processing_failed', 'detail': str(e)}), 500
    # If S3 configured, upload there and return S3 URL
    if S3_BUCKET:
        if not _HAS_BOTO3:
            return jsonify({'error': 's3_configured_boto3_missing'}), 500
        # attempt to upload to S3
        s3_key = f"uploads/{filename}"
        try:
            s3_client = boto3.client('s3', region_name=S3_REGION) if S3_REGION else boto3.client('s3')
            # upload using the possibly modified img_bytes and the determined content type
            upload_stream = BytesIO(img_bytes)
            upload_stream.seek(0)
            s3_client.upload_fileobj(upload_stream, S3_BUCKET, s3_key, ExtraArgs={'ContentType': out_content_type})
            # generate a presigned GET URL
            try:
                url = s3_client.generate_presigned_url('get_object', Params={'Bucket': S3_BUCKET, 'Key': s3_key}, ExpiresIn=PRESIGNED_URL_EXPIRES)
            except Exception:
                # fallback to a constructed URL (not presigned)
                if S3_REGION:
                    url = f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{s3_key}"
                else:
                    url = f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}"
            return jsonify({'url': url, 'storage': 's3', 'presigned_expires': PRESIGNED_URL_EXPIRES}), 201
        except (BotoCoreError, ClientError) as e:
            return jsonify({'error': 's3_upload_failed', 'detail': str(e)}), 500

    # Default: save to local uploads folder
    dest = os.path.join(UPLOAD_FOLDER, filename)
    try:
        # write bytes (possibly resized) to disk
        with open(dest, 'wb') as out:
            out.write(img_bytes)
    except Exception as e:
        app.logger.exception('save failed')
        return jsonify({'error': 'save_failed', 'detail': str(e)}), 500
    return jsonify({'url': f'/uploads/{filename}', 'storage': 'local'}), 201


@app.route('/api/start_stream', methods=['POST'])
def start_stream():
    """Start ffmpeg to pull an RTSP stream and write HLS segments to HLS_FOLDER.

    Expects JSON: { "rtsp_url": "rtsp://...", "target": "stream" }
    """
    global ffmpeg_proc
    data = request.json or {}
    rtsp_url = data.get('rtsp_url')
    target = data.get('target', 'stream')
    if not rtsp_url:
        return jsonify({'error': 'rtsp_url required'}), 400

    playlist = os.path.join(HLS_FOLDER, f"{target}.m3u8")

    with ffmpeg_lock:
        if ffmpeg_proc and ffmpeg_proc.poll() is None:
            return jsonify({'status': 'already_running'}), 200

        # remove old files
        for f in os.listdir(HLS_FOLDER):
            if f.startswith(target):
                try:
                    os.remove(os.path.join(HLS_FOLDER, f))
                except Exception:
                    pass

        # Build ffmpeg command to produce HLS
        cmd = [
            'ffmpeg',
            '-rtsp_transport', 'tcp',
            '-i', rtsp_url,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments',
            '-y',
            playlist
        ]

        try:
            ffmpeg_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            return jsonify({'error': 'ffmpeg not found on server PATH'}), 500

    # wait briefly to allow playlist to be created
    timeout = 5
    start = time.time()
    while time.time() - start < timeout:
        if os.path.exists(playlist):
            break
        time.sleep(0.2)

    if os.path.exists(playlist):
        return jsonify({'status': 'started', 'hls_url': f'/hls/{target}.m3u8'}), 201
    else:
        return jsonify({'status': 'started_but_no_playlist_yet', 'hls_url': f'/hls/{target}.m3u8'}), 202


@app.route('/api/stop_stream', methods=['POST'])
def stop_stream():
    """Stop the running ffmpeg process if any."""
    global ffmpeg_proc
    with ffmpeg_lock:
        if not ffmpeg_proc or ffmpeg_proc.poll() is not None:
            return jsonify({'status': 'not_running'}), 200
        try:
            ffmpeg_proc.send_signal(signal.SIGINT)
            ffmpeg_proc.wait(timeout=5)
        except Exception:
            try:
                ffmpeg_proc.kill()
            except Exception:
                pass
        ffmpeg_proc = None
    return jsonify({'status': 'stopped'}), 200


@app.route('/api/health', methods=['GET'])
def health():
    """Health check: reports if ffmpeg is available and if MongoDB is reachable."""
    ffmpeg_ok = bool(shutil.which('ffmpeg'))
    # attempt to (re)connect to mongo
    mongo_status = 'unknown'
    try:
        ok = ensure_db()
        if DEV_NO_DB:
            mongo_status = 'dev'
        elif ok:
            mongo_status = 'ok'
        else:
            mongo_status = 'error: not_connected'
    except Exception as e:
        mongo_status = f'error: {str(e)}'
    return jsonify({'ffmpeg': ffmpeg_ok, 'mongo': mongo_status}), 200

# Serve frontend build if exists
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    else:
        index_path = os.path.join(app.static_folder, 'index.html')
        if os.path.exists(index_path):
            return send_from_directory(app.static_folder, 'index.html')
        return jsonify({'status':'backend running'}), 200

if __name__ == '__main__':
    # On Windows the Werkzeug reloader can cause socket errors in some environments.
    # Print startup diagnostics so it's obvious in the terminal what's happening.
    print('\n=== Backend startup diagnostics ===')
    try:
        print('cwd:', os.getcwd())
    except Exception:
        pass
    print('MONGO_URI:', MONGO_URI)
    try:
        print('ffmpeg on PATH:', bool(shutil.which('ffmpeg')), '->', shutil.which('ffmpeg'))
    except Exception:
        print('ffmpeg on PATH: error checking')
    try:
        ok = ensure_db()
        print('ensure_db() ->', ok)
    except Exception as e:
        print('ensure_db() exception:', e)
    print('===================================\n')
    app.run(debug=True, host='127.0.0.1', port=5000, use_reloader=False)
