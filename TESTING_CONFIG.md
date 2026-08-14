# Testing Dynamic Configuration

## Quick Test Commands

### 1. Get Current Configuration

```bash
curl http://localhost:3001/api/config
```

Expected response:

```json
{
  "success": true,
  "config": {
    "minMarketCapSol": 5,
    "maxMarketCapSol": 1000000,
    "minMarketCapUsd": 1000,
    "maxMarketCapUsd": 200000000,
    "maxTokenAgeHours": 24,
    "minTokenScore": 30,
    "takeProfitPct": 0.1,
    "stopLossPct": 0.02
  }
}
```

---

### 2. Update Market Cap Range

```bash
curl -X PATCH http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "minMarketCapSol": 10,
    "maxMarketCapSol": 500000,
    "minTokenScore": 40
  }'
```

Check socket events in frontend console for `config:update` emission.

---

### 3. Update Token Age Filter

```bash
curl -X PATCH http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "maxTokenAgeHours": 12
  }'
```

Now only tokens less than 12 hours old will be discovered.

---

### 4. Reset to Defaults

```bash
curl -X POST http://localhost:3001/api/config/reset
```

Resets all values back to .env defaults.

---

## PowerShell Commands

```powershell
# Get config
Invoke-RestMethod -Uri "http://localhost:3001/api/config" -Method GET

# Update config
$body = @{
    minMarketCapSol = 10
    maxMarketCapSol = 500000
    minTokenScore = 40
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3001/api/config" -Method PATCH -Body $body -ContentType "application/json"

# Reset config
Invoke-RestMethod -Uri "http://localhost:3001/api/config/reset" -Method POST
```

---

## Verification Steps

1. **Start Backend:**

   ```bash
   cd backend
   npm run dev
   ```

2. **Check Initial Config:**

   ```bash
   curl http://localhost:3001/api/config
   ```

3. **Update Min Market Cap to 10 SOL:**

   ```bash
   curl -X PATCH http://localhost:3001/api/config \
     -H "Content-Type: application/json" \
     -d '{"minMarketCapSol": 10}'
   ```

4. **Verify in Logs:**
   Look for:

   ```
   [config.route] Configuration updated { old: {...}, new: {...} }
   ```

5. **Check Token Discovery:**
   Should see:

   ```
   [TokenDiscovery] Candidate meets MC range mint=... MC=15.50 SOL ($3100)
   ```

   Tokens below 10 SOL should be filtered out.

6. **Reset and Verify:**
   ```bash
   curl -X POST http://localhost:3001/api/config/reset
   ```
   Should revert to `minMarketCapSol: 5`

---

## Expected Behavior

### Before Update (Default: 5 SOL min)

- Tokens with 5+ SOL market cap pass filter
- Tokens with 3 SOL market cap are filtered out

### After Update (10 SOL min)

- Tokens with 10+ SOL market cap pass filter
- Tokens with 7 SOL market cap are filtered out
- **NO RESTART REQUIRED** - Change takes effect immediately!

### Socket Event Emission

All connected frontend clients should receive:

```javascript
socket.on("config:update", (config) => {
  console.log("⚙️ Config updated:", config);
  // {
  //   minMarketCapSol: 10,
  //   maxMarketCapSol: 500000,
  //   ...
  // }
});
```

---

## Common Use Cases

### 1. Testing with Very Low MC (Development)

```bash
curl -X PATCH http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{"minMarketCapSol": 0.1, "minTokenScore": 0}'
```

Allows almost any token for testing purposes.

---

### 2. Production Settings (Conservative)

```bash
curl -X PATCH http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "minMarketCapSol": 20,
    "maxMarketCapSol": 100000,
    "minTokenScore": 45,
    "maxTokenAgeHours": 12
  }'
```

Only well-established, high-quality tokens.

---

### 3. Aggressive Moonshot Hunting

```bash
curl -X PATCH http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "minMarketCapSol": 1,
    "maxMarketCapSol": 5000,
    "minTokenScore": 20,
    "maxTokenAgeHours": 6
  }'
```

Early-stage tokens with high potential (high risk).

---

## Troubleshooting

### Config Not Updating?

1. Check if route is registered:

   ```bash
   curl http://localhost:3001/api/config
   ```

   Should return config, not 404.

2. Check backend logs for errors:

   ```
   [config.route] Configuration updated
   ```

3. Verify frontend is connected to socket:
   ```javascript
   console.log(socket.connected); // should be true
   ```

### Tokens Still Using Old Config?

- Config updates are immediate for new token discovery cycles
- Existing candidates in memory will use old values
- Wait 30 seconds for next discovery cycle

### Socket Event Not Received?

1. Check socket connection:

   ```javascript
   socket.on("connect", () => console.log("Connected!"));
   ```

2. Add listener before updating config:

   ```javascript
   socket.on("config:update", console.log);
   ```

3. Check CORS settings in backend

---

## Success Indicators

✅ GET /api/config returns current values  
✅ PATCH updates config without restart  
✅ POST /reset reverts to .env defaults  
✅ Socket emits `config:update` on changes  
✅ Token discovery uses new filters immediately  
✅ Logs show updated MC ranges  
✅ Frontend receives config updates in real-time

---

**Dynamic configuration working! No more restarts needed! 🎉**
