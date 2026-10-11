# Runs the ExtendScript builder on an IR fixture through Illustrator's COM interface and exports a PNG preview.
# Usage: powershell -File scripts/ai-test.ps1 fixtures/ir/page-01-lite.json
param(
  [Parameter(Mandatory = $true)][string]$Fixture,
  [string]$AssetDir = "fixtures/out/assets"
)

$root = Split-Path -Parent $PSScriptRoot
$fixturePath = (Resolve-Path (Join-Path $root $Fixture)).Path
$assets = (Resolve-Path (Join-Path $root $AssetDir)).Path -replace '\\', '/'
$outDir = Join-Path $root "fixtures/out"
New-Item -ItemType Directory -Force $outDir | Out-Null

$json = (Get-Content $fixturePath -Raw -Encoding UTF8).Trim()
$json = '{"assetDir":"' + $assets + '",' + $json.Substring(1)
$payload = Join-Path $outDir "payload.json"
[IO.File]::WriteAllText($payload, $json, (New-Object Text.UTF8Encoding $false))

$builder = (Join-Path $root "packages/ai-panel/jsx/builder.jsx") -replace '\\', '/'
$png = (Join-Path $outDir ([IO.Path]::GetFileNameWithoutExtension($Fixture) + ".png")) -replace '\\', '/'
$payloadJs = $payload -replace '\\', '/'

$script = @"
`$.evalFile('$builder');
var result = f2aBuild('$payloadJs');
try {
  var opts = new ExportOptionsPNG24();
  opts.artBoardClipping = true;
  opts.horizontalScale = 200;
  opts.verticalScale = 200;
  app.activeDocument.exportFile(new File('$png'), ExportType.PNG24, opts);
} catch (e) { result = result.replace(/}$/, ',"exportError":"' + e.message + '"}'); }
result;
"@

$ai = New-Object -ComObject Illustrator.Application
$ai.DoJavaScript($script)
