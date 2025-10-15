from dotenv import load_dotenv
import os
from pymongo import MongoClient

load_dotenv()
MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017')
print('Using MONGO_URI:', MONGO_URI)
try:
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    print('Attempting ping...')
    res = client.admin.command('ping')
    print('Ping response:', res)
except Exception as e:
    print('Connection failed:', repr(e))
    import traceback
    traceback.print_exc()
