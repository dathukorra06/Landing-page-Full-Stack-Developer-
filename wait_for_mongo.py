import os
import time
from pymongo import MongoClient

MONGO_URI = os.getenv('MONGO_URI', 'mongodb://mongo:27017')
RETRIES = int(os.getenv('MONGO_RETRY', '10'))
SLEEP = int(os.getenv('MONGO_RETRY_INTERVAL', '2'))

for i in range(RETRIES):
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000)
        client.admin.command('ping')
        print('MongoDB is available')
        break
    except Exception as e:
        print(f'Waiting for MongoDB ({i+1}/{RETRIES})... {e}')
        time.sleep(SLEEP)
else:
    print('MongoDB did not become available, exiting')
    raise SystemExit(1)
