$ErrorActionPreference = "Stop"

Write-Host "OPlusAutoHR README publisher" -ForegroundColor Cyan

# Ensure we are inside a Git repository
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: This folder is not a Git repository." -ForegroundColor Red
    exit 1
}

# Stage all changes
git add .

# Check whether there is anything staged
$staged = git diff --cached --name-only
if ([string]::IsNullOrWhiteSpace(($staged -join ""))) {
    Write-Host "No changes to publish." -ForegroundColor Yellow
    exit 0
}

Write-Host "Files to publish:" -ForegroundColor Cyan
$staged | ForEach-Object { Write-Host "  $_" }

# Commit
$commitMessage = "docs: add bilingual README and project screenshots"
git commit -m $commitMessage
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git commit failed." -ForegroundColor Red
    exit 1
}

# Push current branch
$branch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) {
    $branch = "main"
}

git push origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git push failed." -ForegroundColor Red
    exit 1
}

Write-Host "Done. Refresh your GitHub repository page." -ForegroundColor Green
