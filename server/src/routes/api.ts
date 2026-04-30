import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { db } from '../db/database';
import { Addon } from '../types';
import { getPhotoProviderConfig } from '../services/memories/helpersService';

import authRoutes from './auth';
import tripsRoutes from './trips';
import daysRoutes, { accommodationsRouter as accommodationsRoutes } from './days';
import placesRoutes from './places';
import assignmentsRoutes from './assignments';
import packingRoutes from './packing';
import todoRoutes from './todo';
import tagsRoutes from './tags';
import categoriesRoutes from './categories';
import adminRoutes from './admin';
import mapsRoutes from './maps';
import filesRoutes from './files';
import reservationsRoutes from './reservations';
import dayNotesRoutes from './dayNotes';
import weatherRoutes from './weather';
import settingsRoutes from './settings';
import budgetRoutes from './budget';
import collabRoutes from './collab';
import backupRoutes from './backup';
import oidcRoutes from './oidc';
import vacayRoutes from './vacay';
import atlasRoutes from './atlas';
import memoriesRoutes from './memories/unified';
import notificationRoutes from './notifications';
import shareRoutes from './share';

const router = express.Router();

// Health check
router.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// Auth routes
router.use('/auth', authRoutes);
router.use('/auth/oidc', oidcRoutes);

// Trip-related routes
router.use('/trips', tripsRoutes);
router.use('/trips/:tripId/days', daysRoutes);
router.use('/trips/:tripId/accommodations', accommodationsRoutes);
router.use('/trips/:tripId/places', placesRoutes);
router.use('/trips/:tripId/packing', packingRoutes);
router.use('/trips/:tripId/todo', todoRoutes);
router.use('/trips/:tripId/files', filesRoutes);
router.use('/trips/:tripId/budget', budgetRoutes);
router.use('/trips/:tripId/collab', collabRoutes);
router.use('/trips/:tripId/reservations', reservationsRoutes);
router.use('/trips/:tripId/days/:dayId/notes', dayNotesRoutes);

// Global/Shared routes
router.use('/tags', tagsRoutes);
router.use('/categories', categoriesRoutes);
router.use('/maps', mapsRoutes);
router.use('/weather', weatherRoutes);
router.use('/settings', settingsRoutes);
router.use('/backup', backupRoutes);
router.use('/notifications', notificationRoutes);

// Admin routes
router.use('/admin', adminRoutes);

// Addon routes
router.use('/addons/vacay', vacayRoutes);
router.use('/addons/atlas', atlasRoutes);
router.use('/integrations/memories', memoriesRoutes);

// Root /api level routes
router.use('/', assignmentsRoutes);
router.use('/', shareRoutes);

// Addons list endpoint
router.get('/addons', authenticate, (_req: Request, res: Response) => {
  const addons = db.prepare('SELECT id, name, type, icon, enabled FROM addons WHERE enabled = 1 ORDER BY sort_order').all() as Pick<Addon, 'id' | 'name' | 'type' | 'icon' | 'enabled'>[];
  const providers = db.prepare(`
    SELECT id, name, icon, enabled, sort_order
    FROM photo_providers
    WHERE enabled = 1
    ORDER BY sort_order, id
  `).all() as Array<{ id: string; name: string; icon: string; enabled: number; sort_order: number }>;
  const fields = db.prepare(`
    SELECT provider_id, field_key, label, input_type, placeholder, required, secret, settings_key, payload_key, sort_order
    FROM photo_provider_fields
    ORDER BY sort_order, id
  `).all() as Array<{
    provider_id: string;
    field_key: string;
    label: string;
    input_type: string;
    placeholder?: string | null;
    required: number;
    secret: number;
    settings_key?: string | null;
    payload_key?: string | null;
    sort_order: number;
  }>;

  const fieldsByProvider = new Map<string, typeof fields>();
  for (const field of fields) {
    const arr = fieldsByProvider.get(field.provider_id) || [];
    arr.push(field);
    fieldsByProvider.set(field.provider_id, arr);
  }

  res.json({
    addons: [
      ...addons.map(a => ({ ...a, enabled: !!a.enabled })),
      ...providers.map(p => ({
        id: p.id,
        name: p.name,
        type: 'photo_provider',
        icon: p.icon,
        enabled: !!p.enabled,
        config: getPhotoProviderConfig(p.id),
        fields: (fieldsByProvider.get(p.id) || []).map(f => ({
          key: f.field_key,
          label: f.label,
          input_type: f.input_type,
          placeholder: f.placeholder || '',
          required: !!f.required,
          secret: !!f.secret,
          settings_key: f.settings_key || null,
          payload_key: f.payload_key || null,
          sort_order: f.sort_order,
        })),
      })),
    ],
  });
});

export default router;
