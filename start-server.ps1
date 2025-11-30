# PowerShell script to start the meeting assistant server

# Navigate to the server directory
Set-Location -Path ".\server"

# Check if .env file exists and warn about GEMINI_API_KEY if using Gemini models
if (-not (Test-Path -Path ".\.env")) {
    Write-Host "WARNING: .env file not found in .\server. Please create one if you intend to use Gemini models and set GEMINI_API_KEY." -ForegroundColor Yellow
} else {
    $envContent = Get-Content -Path ".\.env" | Out-String
    if ($envContent -notlike "*GEMINI_API_KEY=*") {
        Write-Host "WARNING: GEMINI_API_KEY not found in .\server\.env. Gemini models will not work without it." -ForegroundColor Yellow
    }
}

# Start the server
Write-Host "Starting meeting assistant server..." -ForegroundColor Green
npm start

# Navigate back to the original directory (optional)
# Set-Location -Path $PSScriptRoot