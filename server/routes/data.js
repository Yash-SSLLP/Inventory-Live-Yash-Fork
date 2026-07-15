import { Router } from 'express';
import Dataset from '../models/Dataset.js';
import { ensureSeeded } from '../lib/seedData.js';

const router = Router();

// GET /api/data — returns the full dataset object (the original `D`).
router.get('/', async (req, res) => {
  try {
    const doc = await Dataset.findOne({ key: 'main' }).lean();
    if (!doc) {
      return res.status(404).json({
        error: 'Dataset not seeded. Run `npm run seed` in the server folder.',
      });
    }
    res.json(doc.data);
  } catch (err) {
    console.error('[data] error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/data — persist the whole in-memory dataset `D` (with all uploaded data
// applied / the catalog rebuilt from raw uploads) back into Mongo, so it becomes the
// single source of truth and survives reloads / other devices.
router.put('/', async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || !Array.isArray(data.products)) {
      return res.status(400).json({ error: 'Body must be the dataset object with a products array.' });
    }
    await Dataset.findOneAndUpdate(
      { key: 'main' },
      { key: 'main', data },
      { upsert: true, new: true }
    );
    res.json({ ok: true, products: data.products.length });
  } catch (err) {
    console.error('[data] put error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/data/reset — restore the built-in synthetic seed (used by "Clear all data").
router.post('/reset', async (req, res) => {
  try {
    const result = await ensureSeeded({ force: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[data] reset error', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
