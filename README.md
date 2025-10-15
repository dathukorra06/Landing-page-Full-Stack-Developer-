# RTSP Overlay Demo (Flask + React)

This demo shows how to play an RTSP livestream (via an RTSP -> HLS transcode) in a React frontend, and manage overlays (logo/text) stored in MongoDB via a Flask CRUD API.

## Features

## Quick steps (full details below)

1. Install dependencies for backend and frontend.
2. Run ffmpeg to convert RTSP to HLS (example uses rtsp://rtsp.me/sample).
3. Start Flask backend (serves API and HLS static files).
4. Start React frontend and open http://localhost:3000.

### Example ffmpeg command (run locally)
Replace `<RTSP_URL>` and run from the backend directory:
```
mkdir -p static/hls
ffmpeg -rtsp_transport tcp -i "<RTSP_URL>" -c:v copy -c:a aac -f hls -hls_time 2 -hls_list_size 3 -hls_flags delete_segments static/hls/stream.m3u8
```
This will create `static/hls/stream.m3u8` served by Flask as a live-ish HLS stream.

Running the demo
----------------

Prerequisites:
- Python 3.8+
- Node.js and npm
- ffmpeg installed and available on the system PATH (required by the backend to proxy RTSP -> HLS)
- MongoDB (local or remote) or set MONGO_URI in a .env

Backend (Flask):

1. Create a virtualenv and install requirements:

  python -m venv .venv; .\.venv\Scripts\activate; pip install -r backend/requirements.txt

2. Ensure ffmpeg is installed (for Windows, add ffmpeg.exe to PATH). Test with `ffmpeg -version`.

3. Start the backend:

  set FLASK_APP=backend/app.py; python backend/app.py

API endpoints of interest:
- GET /api/overlays
- POST /api/overlays
- PUT /api/overlays/<id>
- DELETE /api/overlays/<id>
- POST /api/start_stream  { rtsp_url: "rtsp://...", target: "stream" }
- POST /api/stop_stream

Frontend (React):

1. Install dependencies and start:

  cd frontend; npm install; npm start

2. Open http://localhost:3000 (or the URL printed by react-scripts). Use the RTSP input to start a stream. The backend will proxy the RTSP into HLS segments served at /hls/stream.m3u8 and the frontend plays that.

Notes and troubleshooting:
- The backend uses ffmpeg to create HLS segments. If ffmpeg isn't found, the /api/start_stream endpoint will return an error.
- For testing you can use a public RTSP source such as rtsp://rtsp.me/sample or other sample streams.
- Overlays are stored in MongoDB; set MONGO_URI in a .env file or rely on the default mongodb://localhost:27017.

Uploads and S3 support
----------------------
- The backend supports image uploads via `POST /api/upload` (multipart/form-data field `file`).
- By default uploads are stored in `static/uploads` and served at `/uploads/<filename>`.
- You can enable S3 storage by setting environment variables `S3_BUCKET` (required) and optionally `S3_REGION`, and ensuring AWS credentials are available in the environment (e.g. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` or an instance role).
- Upload validation: only image MIME types (png/jpeg/gif/webp) are accepted and there's a default max size of 5 MB (configurable with `MAX_UPLOAD_SIZE`).
 - When S3 is enabled uploads are stored as private objects. The backend will return a presigned GET URL (expires after `PRESIGNED_URL_EXPIRES` seconds, default 3600). Set `PRESIGNED_URL_EXPIRES` to change the expiration time.

MongoDB Atlas usage
-------------------
If you are using MongoDB Atlas, update `backend/.env` with your connection string and password. Example:

MONGO_URI=mongodb+srv://dathukorra:<db_password>@cluster0.lhauryw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0

Replace `<db_password>` with your database user's password. Keep `.env` out of git and restart the backend after updating the file.

### Backend (Flask)

Configure MongoDB via environment variable `MONGO_URI` (default `mongodb://localhost:27017`).

### Frontend (React)
  - plays the HLS stream using hls.js (CDN)
  - fetches/creates/updates/deletes overlays
  - renders overlays as absolutely positioned divs (editable via inputs)

## How overlays work
Overlays are simple JSON objects:
```json
{
  "_id": "<id>",
  "x": 10, "y": 20, "width": 200, "height": 50,
  "content": "Hello World", "type": "text"
}
```
Coordinates are in pixels relative to the video container (you can change to percentages).

## Files included

This is a demo scaffold. For production use consider:
### API Documentation

Base URL: `http://localhost:5000`

Overlays (CRUD)

- GET /api/overlays
  - Response: 200 JSON array of overlay objects.

- POST /api/overlays
  - Body (application/json):
    {
      "x": 10,
      "y": 20,
      "width": 200,
      "height": 50,
      "content": "Hello",
      "type": "text"
    }
  - Response: 201 JSON overlay object (with `_id`).

- PUT /api/overlays/<id>
  - Body: partial or full overlay object to update.
  - Response: 200 JSON overlay object (updated).

- DELETE /api/overlays/<id>
  - Response: 204 No Content on success.

Stream control

- POST /api/start_stream
  - Body: `{ "rtsp_url": "rtsp://...", "target": "stream" }`
  - Starts ffmpeg on the server to pull the RTSP stream and write HLS to `static/hls/<target>.m3u8`.
  - Response: 201 or 202 with `{ "status": ..., "hls_url": "/hls/<target>.m3u8" }`.

- POST /api/stop_stream
  - Stops the running ffmpeg process.
  - Response: 200 JSON `{ "status": "stopped" }`.

- GET /api/health
  - Returns basic health information about required services:
    `{ "ffmpeg": true|false, "mongo": "ok"|"error: ..." }`.

Examples

1. Start stream (curl):

```bash
curl -X POST -H "Content-Type: application/json" -d '{"rtsp_url":"rtsp://rtsp.me/sample","target":"stream"}' http://localhost:5000/api/start_stream
```

2. Get overlays:

```bash
curl http://localhost:5000/api/overlays
```

Security and production notes
- The API is unauthenticated in this demo. Add authentication and authorization before using in production.
- Validate and sanitize overlay content to avoid XSS if overlay content is ever rendered as HTML.

Run both frontend and backend (PowerShell helper scripts)
-----------------------------------------------------
For convenience this repo includes PowerShell helper scripts and a VS Code tasks file to run both services:

- To run backend only:
  ```powershell
  .\run_backend.ps1
  ```

- To run frontend only:
  ```powershell
  .\run_frontend.ps1
  ```

- Or in VS Code run the task `Run Full App` (it runs backend and frontend in parallel).

Notes: The backend script will `pip install -r backend/requirements.txt` automatically; the frontend script will run `npm install` if needed.

Run with Docker Compose
-----------------------
You can run the full stack (MongoDB, backend, frontend) with Docker Compose. From the repository root run:

```powershell
docker-compose up --build
```

This will:
- start a MongoDB service on port 27017
- build and start the backend on port 5000
- build and start the frontend (served by nginx) on port 3000

Notes:
- Ensure Docker is installed and running.
- The backend Docker image includes `ffmpeg` and will attempt to run the ffmpeg command when you call `/api/start_stream`. If you need hardware acceleration or a specific ffmpeg build, modify the `backend/Dockerfile`.
The docker-compose setup includes a MongoDB healthcheck and the backend image runs a small `wait_for_mongo.py` script on startup to ensure MongoDB is reachable before the Flask app starts.

