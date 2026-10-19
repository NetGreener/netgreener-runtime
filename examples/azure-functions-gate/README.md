# Azure Functions gate (isolated)

Isolated serverless-thin dogfood for `CHK-R6.serverless-degraded`.

**Does not** touch existing NetGreener prod resources. Create under
`rg-ng-runtime-gate-test` only. Env secrets live in
`../../.env.azure-test-servers` (gitignored).

## Deployed app (example)

- Function App: `fn-ng-runtime-gate-20261014`
- URL: `https://fn-ng-runtime-gate-20261014.azurewebsites.net/api/health`

## Local publish

```powershell
npm install
func azure functionapp publish fn-ng-runtime-gate-20261014 --javascript
```

## Tear down

```powershell
az group delete -n rg-ng-runtime-gate-test --yes
```
