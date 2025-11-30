# PowerShell script to start the meeting assistant web application

# Navigate to the web directory
Set-Location -Path ".\web"

# Start the web application
Write-Host "Starting meeting assistant web application..." -ForegroundColor Green
npm run dev

# Navigate back to the original directory (optional)
# Set-Location -Path $PSScriptRoot