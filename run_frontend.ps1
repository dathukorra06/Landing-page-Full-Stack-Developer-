# Install frontend deps and start
cd frontend
if (-not (Test-Path node_modules)) {
  npm install
}
npm start
