import express from 'express'

const app = express()
app.get('/health', (_req, res) => {
  res.json({ ok: true })
})
app.post('/v1/items/:id', async (_req, res) => {
  res.json({ ok: true })
})

export default app
