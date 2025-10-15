# Activate virtualenv and run backend
if (Test-Path .\.venv\Scripts\Activate.ps1) {
  . .\.venv\Scripts\Activate.ps1
}
# Install requirements if needed
pip install -r backend/requirements.txt
# Run backend
python backend/app.py
