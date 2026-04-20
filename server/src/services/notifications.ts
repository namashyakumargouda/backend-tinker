import nodemailer from 'nodemailer';
import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';
import { logInfo, logDebug, logError } from './auditLog';
import { checkSsrf, createPinnedDispatcher } from '../utils/ssrfGuard';

// ── Types ──────────────────────────────────────────────────────────────────

import type { NotifEventType } from './notificationPreferencesService';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

// ── HTML escaping ──────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Settings helpers ───────────────────────────────────────────────────────

function getAppSetting(key: string): string | null {
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || null;
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST || getAppSetting('smtp_host');
  const port = process.env.SMTP_PORT || getAppSetting('smtp_port');
  const user = process.env.SMTP_USER || getAppSetting('smtp_user');
  const pass = process.env.SMTP_PASS || decrypt_api_key(getAppSetting('smtp_pass')) || '';
  const from = process.env.SMTP_FROM || getAppSetting('smtp_from');
  if (!host || !port || !from) return null;
  return { host, port: parseInt(port, 10), user: user || '', pass: pass || '', from, secure: parseInt(port, 10) === 465 };
}

// Exported for use by notificationService
export function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const origins = process.env.ALLOWED_ORIGINS;
  if (origins && !origins.includes(',')) return origins.trim();
  return 'http://localhost:3000';
}

export function getUserLanguage(userId: number): string {
  return (db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'language'").get(userId) as { value: string } | undefined)?.value || 'en';
}

export function getUserEmail(userId: number): string | null {
  return (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined)?.email || null;
}

export function getUserWebhookUrl(userId: number): string | null {
  const value = (db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'webhook_url'").get(userId) as { value: string } | undefined)?.value || null;
  return value ? decrypt_api_key(value) : null;
}

export function getAdminWebhookUrl(): string | null {
  const value = getAppSetting('admin_webhook_url');
  return value ? decrypt_api_key(value) : null;
}

interface EmailStrings {
  footer: string;
  manage: string;
  madeWith: string;
  openApp: string;
}

const I18N: Record<string, EmailStrings> = {
  en: { footer: 'You received this because you have notifications enabled in Travel Planner.', manage: 'Manage preferences in Settings', madeWith: 'Made with', openApp: 'Open Travel Planner' },
  de: { footer: 'Du erhältst diese E-Mail, weil du Benachrichtigungen in Travel Planner aktiviert hast.', manage: 'Einstellungen verwalten', madeWith: 'Made with', openApp: 'Travel Planner öffnen' },
  fr: { footer: 'Vous recevez cet e-mail car les notifications sont activées dans Travel Planner.', manage: 'Gérer les préférences', madeWith: 'Made with', openApp: 'Ouvrir Travel Planner' },
  es: { footer: 'Recibiste esto porque tienes las notificaciones activadas en Travel Planner.', manage: 'Gestionar preferencias', madeWith: 'Made with', openApp: 'Abrir Travel Planner' },
  nl: { footer: 'Je ontvangt dit omdat je meldingen hebt ingeschakeld in Travel Planner.', manage: 'Voorkeuren beheren', madeWith: 'Made with', openApp: 'Travel Planner openen' },
  ru: { footer: 'Вы получили это, потому что у вас включены уведомления в Travel Planner.', manage: 'Управление настройками', madeWith: 'Made with', openApp: 'Открыть Travel Planner' },
  zh: { footer: '您收到此邮件是因为您在 Travel Planner 中启用了通知。', manage: '管理偏好设置', madeWith: 'Made with', openApp: '打开 Travel Planner' },
  'zh-TW': { footer: '您收到這封郵件是因為您在 Travel Planner 中啟用了通知。', manage: '管理偏好設定', madeWith: 'Made with', openApp: '開啟 Travel Planner' },
  ar: { footer: 'تلقيت هذا لأنك قمت بتفعيل الإشعارات في Travel Planner.', manage: 'إدارة التفضيلات', madeWith: 'Made with', openApp: 'فتح Travel Planner' },
};

// Translated notification texts per event type
interface EventText { title: string; body: string }
type EventTextFn = (params: Record<string, string>) => EventText

const EVENT_TEXTS: Record<string, Record<NotifEventType, EventTextFn>> = {
  en: {
    trip_invite: p => ({ title: `Trip invite: "${p.trip}"`, body: `${p.actor} invited ${p.invitee || 'a member'} to the trip "${p.trip}".` }),
    booking_change: p => ({ title: `New booking: ${p.booking}`, body: `${p.actor} added a new ${p.type} "${p.booking}" to "${p.trip}".` }),
    trip_reminder: p => ({ title: `Trip reminder: ${p.trip}`, body: `Your trip "${p.trip}" is coming up soon!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion Invite', body: `${p.actor} invited you to fuse vacation plans. Open Travel Planner to accept or decline.` }),
    photos_shared: p => ({ title: `${p.count} photos shared`, body: `${p.actor} shared ${p.count} photo(s) in "${p.trip}".` }),
    collab_message: p => ({ title: `New message in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Packing: ${p.category}`, body: `${p.actor} assigned you to the "${p.category}" packing category in "${p.trip}".` }),
    version_available: p => ({ title: 'New Travel Planner version available', body: `Travel Planner ${p.version} is now available. Visit the admin panel to update.` }),
  },
  de: {
    trip_invite: p => ({ title: `Einladung zu "${p.trip}"`, body: `${p.actor} hat ${p.invitee || 'ein Mitglied'} zur Reise "${p.trip}" eingeladen.` }),
    booking_change: p => ({ title: `Neue Buchung: ${p.booking}`, body: `${p.actor} hat eine neue Buchung "${p.booking}" (${p.type}) zu "${p.trip}" hinzugefügt.` }),
    trip_reminder: p => ({ title: `Reiseerinnerung: ${p.trip}`, body: `Deine Reise "${p.trip}" steht bald an!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion-Einladung', body: `${p.actor} hat dich eingeladen, Urlaubspläne zu fusionieren. Öffne Travel Planner um anzunehmen oder abzulehnen.` }),
    photos_shared: p => ({ title: `${p.count} Fotos geteilt`, body: `${p.actor} hat ${p.count} Foto(s) in "${p.trip}" geteilt.` }),
    collab_message: p => ({ title: `Neue Nachricht in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Packliste: ${p.category}`, body: `${p.actor} hat dich der Kategorie "${p.category}" in der Packliste von "${p.trip}" zugewiesen.` }),
    version_available: p => ({ title: 'Neue Travel Planner-Version verfügbar', body: `Travel Planner ${p.version} ist jetzt verfügbar. Besuche das Admin-Panel zum Aktualisieren.` }),
  },
  fr: {
    trip_invite: p => ({ title: `Invitation à "${p.trip}"`, body: `${p.actor} a invité ${p.invitee || 'un membre'} au voyage "${p.trip}".` }),
    booking_change: p => ({ title: `Nouvelle réservation : ${p.booking}`, body: `${p.actor} a ajouté une réservation "${p.booking}" (${p.type}) à "${p.trip}".` }),
    trip_reminder: p => ({ title: `Rappel de voyage : ${p.trip}`, body: `Votre voyage "${p.trip}" approche !` }),
    vacay_invite: p => ({ title: 'Invitation Vacay Fusion', body: `${p.actor} vous invite à fusionner les plans de vacances. Ouvrez Travel Planner pour accepter ou refuser.` }),
    photos_shared: p => ({ title: `${p.count} photos partagées`, body: `${p.actor} a partagé ${p.count} photo(s) dans "${p.trip}".` }),
    collab_message: p => ({ title: `Nouveau message dans "${p.trip}"`, body: `${p.actor} : ${p.preview}` }),
    packing_tagged: p => ({ title: `Bagages : ${p.category}`, body: `${p.actor} vous a assigné à la catégorie "${p.category}" dans "${p.trip}".` }),
    version_available: p => ({ title: 'Nouvelle version Travel Planner disponible', body: `Travel Planner ${p.version} est maintenant disponible. Rendez-vous dans le panneau d'administration pour mettre à jour.` }),
  },
  es: {
    trip_invite: p => ({ title: `Invitación a "${p.trip}"`, body: `${p.actor} invitó a ${p.invitee || 'un miembro'} al viaje "${p.trip}".` }),
    booking_change: p => ({ title: `Nueva reserva: ${p.booking}`, body: `${p.actor} añadió una reserva "${p.booking}" (${p.type}) a "${p.trip}".` }),
    trip_reminder: p => ({ title: `Recordatorio: ${p.trip}`, body: `¡Tu viaje "${p.trip}" se acerca!` }),
    vacay_invite: p => ({ title: 'Invitación Vacay Fusion', body: `${p.actor} te invitó a fusionar planes de vacaciones. Abre Travel Planner para aceptar o rechazar.` }),
    photos_shared: p => ({ title: `${p.count} photos compartidas`, body: `${p.actor} compartió ${p.count} photo(s) en "${p.trip}".` }),
    collab_message: p => ({ title: `Nuevo mensaje en "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Equipaje: ${p.category}`, body: `${p.actor} te asignó a la categoría "${p.category}" en "${p.trip}".` }),
    version_available: p => ({ title: 'Nueva versión de Travel Planner disponible', body: `Travel Planner ${p.version} ya está disponible. Visita el panel de administración para actualizar.` }),
  },
  nl: {
    trip_invite: p => ({ title: `Uitnodiging voor "${p.trip}"`, body: `${p.actor} heeft ${p.invitee || 'een lid'} uitgenodigd voor de reis "${p.trip}".` }),
    booking_change: p => ({ title: `Nieuwe boeking: ${p.booking}`, body: `${p.actor} heeft een boeking "${p.booking}" (${p.type}) toegevoegd aan "${p.trip}".` }),
    trip_reminder: p => ({ title: `Reisherinnering: ${p.trip}`, body: `Je reis "${p.trip}" komt eraan!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion uitnodiging', body: `${p.actor} nodigt je uit om vakantieplannen te fuseren. Open Travel Planner om te accepteren of af te wijzen.` }),
    photos_shared: p => ({ title: `${p.count} foto's gedeeld`, body: `${p.actor} heeft ${p.count} foto('s) gedeeld in "${p.trip}".` }),
    collab_message: p => ({ title: `Nieuw bericht in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Paklijst: ${p.category}`, body: `${p.actor} heeft je toegewezen aan de categorie "${p.category}" in "${p.trip}".` }),
    version_available: p => ({ title: 'Nieuwe Travel Planner-versie beschikbaar', body: `Travel Planner ${p.version} is nu beschikbaar. Bezoek het beheerderspaneel om bij te werken.` }),
  },
  ru: {
    trip_invite: p => ({ title: `Приглашение в "${p.trip}"`, body: `${p.actor} пригласил ${p.invitee || 'участника'} в поездку "${p.trip}".` }),
    booking_change: p => ({ title: `Новое бронирование: ${p.booking}`, body: `${p.actor} добавил бронирование "${p.booking}" (${p.type}) в "${p.trip}".` }),
    trip_reminder: p => ({ title: `Напоминание: ${p.trip}`, body: `Ваша поездка "${p.trip}" скоро начнётся!` }),
    vacay_invite: p => ({ title: 'Приглашение Vacay Fusion', body: `${p.actor} приглашает вас объединить планы отпуска. Откройте Travel Planner для подтверждения.` }),
    photos_shared: p => ({ title: `${p.count} фото`, body: `${p.actor} поделился ${p.count} фото в "${p.trip}".` }),
    collab_message: p => ({ title: `Новое сообщение в "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Список вещей: ${p.category}`, body: `${p.actor} назначил вас в категорию "${p.category}" в "${p.trip}".` }),
    version_available: p => ({ title: 'Доступна новая версия Travel Planner', body: `Travel Planner ${p.version} теперь доступен. Перейдите в панель администратора для обновления.` }),
  },
  zh: {
    trip_invite: p => ({ title: `旅行邀请: "${p.trip}"`, body: `${p.actor} 邀请了 ${p.invitee || '一位成员'} 加入旅行 "${p.trip}"。` }),
    booking_change: p => ({ title: `新预订: ${p.booking}`, body: `${p.actor} 在 "${p.trip}" 中添加了新的 ${p.type} "${p.booking}"。` }),
    trip_reminder: p => ({ title: `旅行提醒: ${p.trip}`, body: `您的旅行 "${p.trip}" 即将开始！` }),
    vacay_invite: p => ({ title: 'Vacay Fusion 邀请', body: `${p.actor} 邀请您合并度假计划。打开 Travel Planner 以接受或拒绝。` }),
    photos_shared: p => ({ title: `已分享 ${p.count} 张照片`, body: `${p.actor} 在 "${p.trip}" 中分享了 ${p.count} 张照片。` }),
    collab_message: p => ({ title: `"${p.trip}" 中的新消息`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `打包清单: ${p.category}`, body: `${p.actor} 将您分配到 "${p.trip}" 中的 "${p.category}" 打包类别。` }),
    version_available: p => ({ title: '有新的 Travel Planner 版本可用', body: `Travel Planner ${p.version} 现已可用。请访问管理面板进行更新。` }),
  },
  'zh-TW': {
    trip_invite: p => ({ title: `旅行邀請: "${p.trip}"`, body: `${p.actor} 邀請了 ${p.invitee || '一位成員'} 加入旅行 "${p.trip}"。` }),
    booking_change: p => ({ title: `新預訂: ${p.booking}`, body: `${p.actor} 在 "${p.trip}" 中添加了新的 ${p.type} "${p.booking}"。` }),
    trip_reminder: p => ({ title: `旅行提醒: ${p.trip}`, body: `您的旅行 "${p.trip}" 即將開始！` }),
    vacay_invite: p => ({ title: 'Vacay Fusion 邀請', body: `${p.actor} 邀請您合併度假計劃。打開 Travel Planner 以接受或拒絶。` }),
    photos_shared: p => ({ title: `已分享 ${p.count} 張照片`, body: `${p.actor} 在 "${p.trip}" 中分享了 ${p.count} 張照片。` }),
    collab_message: p => ({ title: `"${p.trip}" 中的新消息`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `打包清單: ${p.category}`, body: `${p.actor} 將您分配到 "${p.trip}" 中的 "${p.category}" 打包類別。` }),
    version_available: p => ({ title: '有新的 Travel Planner 版本可用', body: `Travel Planner ${p.version} 現已可用。請訪問管理面板進行更新。` }),
  },
  ar: {
    trip_invite: p => ({ title: `دعوة للرحلة: "${p.trip}"`, body: `قام ${p.actor} بدعوة ${p.invitee || 'عضو'} للرحلة "${p.trip}".` }),
    booking_change: p => ({ title: `حجز جديد: ${p.booking}`, body: `قام ${p.actor} بإضافة ${p.type} جديد "${p.booking}" إلى "${p.trip}".` }),
    trip_reminder: p => ({ title: `تذكير بالرحلة: ${p.trip}`, body: `رحلتك "${p.trip}" ستبدأ قريباً!` }),
    vacay_invite: p => ({ title: 'دعوة Vacay Fusion', body: `قام ${p.actor} بدعوتك لدمج خطط العطلة. افتح Travel Planner للقبول أو الرفض.` }),
    photos_shared: p => ({ title: `تم مشاركة ${p.count} صور`, body: `قام ${p.actor} بمشاركة ${p.count} صورة في "${p.trip}".` }),
    collab_message: p => ({ title: `رسالة جديدة في "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `قائمة التعبئة: ${p.category}`, body: `قام ${p.actor} بتعيينك في فئة التعبئة "${p.category}" في "${p.trip}".` }),
    version_available: p => ({ title: 'إصدار جديد من Travel Planner متاح', body: `الإصدار ${p.version} من Travel Planner متاح الآن. قم بزيارة لوحة الإدارة للتحديث.` }),
  }
};

export function getEventText(lang: string = 'en', event: NotifEventType, params: Record<string, string>): EventText {
  const texts = EVENT_TEXTS[lang] || EVENT_TEXTS.en;
  const fn = texts[event] || EVENT_TEXTS.en[event];
  return fn(params);
}

// ── Email Builder ──────────────────────────────────────────────────────────

export function buildEmailHtml(subject: string, body: string, lang: string = 'en', navigateTarget?: string): string {
  const s = I18N[lang] || I18N.en;
  const safeSubject = escapeHtml(subject);
  const safeBody = escapeHtml(body);
  const appUrl = getAppUrl();
  const ctaHref = navigateTarget ? `${appUrl}${navigateTarget}` : appUrl;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr><td style="background: linear-gradient(135deg, #000000 0%, #1a1a2e 100%); padding: 32px 32px 28px; text-align: center;">
          <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj4NCiAgPGRlZnM+DQogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzFlMjkzYiIvPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+DQogICAgPC9saW5lYXJHcmFkaWVudD4NCiAgICA8Y2xpcFBhdGggaWQ9Imljb24iPg0KICAgICAgPHBhdGggZD0iTSA4NTUuNjM2NzE5IDY5OS4yMDMxMjUgTCAyMjIuMjQ2MDk0IDY5OS4yMDMxMjUgQyAxOTcuNjc5Njg4IDY5OS4yMDMxMjUgMTc5LjkwNjI1IDY3NS43NSAxODYuNTM5MDYyIDY1Mi4xMDE1NjIgTCAzNjAuNDI5Njg4IDMyLjM5MDYyNSBDIDM2NC45MjE4NzUgMTYuMzg2NzE5IDM3OS41MTE3MTkgNS4zMjgxMjUgMzk2LjEzMjgxMiA1LjMyODEyNSBMIDEwMjkuNTI3MzQ0IDUuMzI4MTI1IEMgMTA1NC4wODk4NDQgNS4zMjgxMjUgMTA3MS44NjcxODggMjguNzc3MzQ0IDEwNjUuMjMwNDY5IDUyLjQyOTY4OCBMIDg5MS4zMzk4NDQgNjcyLjEzNjcxOSBDIDg5MS4zMzk4NDQgNjcyLjEzNjcxOSBDIDg5MS4zMzk4NDQgNjcyLjEzNjcxOSBDIDg5MS4zMzk4NDQgNjcyLjEzNjcxOSBaIE0gNDQ0LjIzODI4MSAxMTY2Ljk4MDQ2OSBMIDUzMy43NzM0MzggODQ3Ljg5ODQzOCBDIDU0MC40MTAxNTYgODI0LjI0NjA5NCA1MjIuNjMyODEyIDgwMC43OTY4NzUgNDk4LjA3MDMxMiA4MDAuNzk2ODc1IEwgMTcyLjQ3MjY1NiA4MDAuNzk2ODc1IEMgMTU1Ljg1MTU2MiA4MDAuNzk2ODc1IDE0MS4yNjE3MTkgODExLjg1NTQ2OSAxMzYuNzY5NTMxIDgyNy44NTkzNzUgTCA0Ny4yMzQzNzUgMTE0Ni45NDE0MDYgQyA0MC41OTc2NTYgMTE3MC41OTM3NSA1OC4zNzUgMTE5NC4wNDI5NjkgODIuOTM3NSAxMTk0LjA0Mjk2OSBMIDQwOC41MzUxNTYgMTE5NC4wNDI5NjkgQyA0MjUuMTU2MjUgMTE5NC4wNDI5NjkgNDM5Ljc1IDExODIuOTg0Mzc1IDQ0NC4yMzgyODEgMTE2Ni45ODA0NjkgWiBNIDYwOS4wMDM5MDYgODI3Ljg1OTM3NSBMIDQzNS4xMTEzMjggMTQ0Ny41NzAzMTIgQyA0MjguNDc2NTYyIDE0NzEuMjE4NzUgNDQ2LjI1MzkwNiAxNDk0LjY3MTg3NSA0NzAuODE2NDA2IDE0OTQuNjcxODc1IEwgMTEwNC4yMTA5MzggMTQ5NC42NzE4NzUgQyAxMTIwLjgzMjAzMSAxNDk0LjY3MTg3NSAxMTM1LjQyMTg3NSAxNDgzLjYwOTM3NSAxMTM5LjkxNDA2MiAxNDY3LjYwNTQ2OSBMIDEzMTMuODA0Njg4IDg0Ny44OTg0MzggQyAxMzIwLjQ0MTQwNiA4MjQuMjQ2MDk0IDEzMDIuNjY0MDYyIDgwMC43OTY4NzUgMTI3OC4xMDE1NjIgODAwLjc5Njg3NSBMIDY0NC43MDcwMzEgODAwLjc5Njg3NSBDIDYyOC4wODU5MzggODAwLjc5Njg3NSA2MTMuNDkyMTg4IDgxMS44NTU0NjkgNjA5LjAwMzkwNiA4MjcuODU5Mzc1IFogTSAxMDU2LjEwNTQ2OSAzMzMuMDE5NTMxIEwgOTY2LjU3MDMxMiA2NTIuMTAxNTYyIEMgOTU5LjkzMzU5NCA2NzUuNzUgOTc3LjcxMDkzOCA2OTkuMjAzMTI1IDEwMDIuMjczNDM4IDY5OS4yMDMxMjUgTCAxMzI3Ljg3MTA5NCA2OTkuMjAzMTI1IEMgMTM0NC40OTIxODggNjk5LjIwMzEyNSAxMzU5LjA4NTkzOCA2ODguMTQwNjI1IDEzNjMuNTc0MjE5IDY3Mi4xMzY3MTkgTCAxNDUzLjEwOTM3NSAzNTMuMDU0Njg4IEMgMTQ1OS43NDYwOTQgMzI5LjQwNjI1IDE0NDEuOTY4NzUgMzA1Ljk1MzEyNSAxNDE3LjQwNjI1IDMwNS45NTMxMjUgTCAxMDkxLjgwODU5NCAzMDUuOTUzMTI1IEMgMTA3NS4xODc1IDMwNS45NTMxMjUgMTA2MC41OTc2NTYgMzE3LjAxNTYyNSAxMDU2LjEwNTQ2OSAzMzMuMDE5NTMxIFoiLz4NCiAgICA8L2NsaXBQYXRoPg0KICA8L2RlZnM+DQogIDxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2JnKSIvPg0KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg1Niw1MSkgc2NhbGUoMC4yNjcpIj4NCiAgICA8cmVjdCB3aWR0aD0iMTUwMCIgaGVpZ2h0PSIxNTAwIiBmaWxsPSIjZmZmZmZmIiBjbGlwLXBhdGg9InVybCgjaWNvbikiLz4NCiAgPC9nPg0KPC9zdmc+DQo=" alt="Travel Planner" width="48" height="48" style="border-radius: 14px; margin-bottom: 14px; display: block; margin-left: auto; margin-right: auto;" />
          <div style="color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">Travel Planner</div>
          <div style="color: rgba(255,255,255,0.4); font-size: 10px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; margin-top: 4px;">Travel Resource &amp; Exploration Kit</div>
        </td></tr>
        <!-- Content -->
        <tr><td style="padding: 32px 32px 16px;">
          <h1 style="margin: 0 0 8px; font-size: 18px; font-weight: 700; color: #111827; line-height: 1.3;">${safeSubject}</h1>
          <div style="width: 32px; height: 3px; background: #111827; border-radius: 2px; margin-bottom: 20px;"></div>
          <p style="margin: 0; font-size: 14px; color: #4b5563; line-height: 1.7; white-space: pre-wrap;">${safeBody}</p>
        </td></tr>
        <!-- CTA -->
        ${appUrl ? `<tr><td style="padding: 8px 32px 32px; text-align: center;">
          <a href="${ctaHref}" style="display: inline-block; padding: 12px 28px; background: #111827; color: #ffffff; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 10px; letter-spacing: 0.2px;">${s.openApp}</a>
        </td></tr>` : ''}
        <!-- Footer -->
        <tr><td style="padding: 20px 32px; background: #f9fafb; border-top: 1px solid #f3f4f6; text-align: center;">
          <p style="margin: 0 0 8px; font-size: 11px; color: #9ca3af; line-height: 1.5;">${s.footer}<br>${s.manage}</p>
          <p style="margin: 0; font-size: 10px; color: #d1d5db;">${s.madeWith} <span style="color: #ef4444;">&hearts;</span> by Maurice &middot; <a href="https://github.com/mauriceboe/travel-planner" style="color: #9ca3af; text-decoration: none;">GitHub</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send functions ─────────────────────────────────────────────────────────

export async function sendEmail(to: string, subject: string, body: string, userId?: number, navigateTarget?: string): Promise<boolean> {
  const config = getSmtpConfig();
  if (!config) return false;

  const lang = userId ? getUserLanguage(userId) : 'en';

  try {
    const skipTls = process.env.SMTP_SKIP_TLS_VERIFY === 'true' || getAppSetting('smtp_skip_tls_verify') === 'true';
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      ...(skipTls ? { tls: { rejectUnauthorized: false } } : {}),
    });

    await transporter.sendMail({
      from: config.from,
      to,
      subject: `Travel Planner — ${subject}`,
      text: body,
      html: buildEmailHtml(subject, body, lang, navigateTarget),
    });
    logInfo(`Email sent to=${to} subject="${subject}"`);
    logDebug(`Email smtp=${config.host}:${config.port} from=${config.from} to=${to}`);
    return true;
  } catch (err) {
    logError(`Email send failed to=${to}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export function buildWebhookBody(url: string, payload: { event: string; title: string; body: string; tripName?: string; link?: string }): string {
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//.test(url);
  const isSlack = /hooks\.slack\.com\//.test(url);

  if (isDiscord) {
    return JSON.stringify({
      embeds: [{
        title: `📍 ${payload.title}`,
        description: payload.body,
        url: payload.link,
        color: 0x3b82f6,
        footer: { text: payload.tripName ? `Trip: ${payload.tripName}` : 'Travel Planner' },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (isSlack) {
    const trip = payload.tripName ? `  •  _${payload.tripName}_` : '';
    const link = payload.link ? `\n<${payload.link}|Open in Travel Planner>` : '';
    return JSON.stringify({
      text: `*${payload.title}*\n${payload.body}${trip}${link}`,
    });
  }

  return JSON.stringify({ ...payload, timestamp: new Date().toISOString(), source: 'Travel Planner' });
}

export async function sendWebhook(url: string, payload: { event: string; title: string; body: string; tripName?: string; link?: string }): Promise<boolean> {
  if (!url) return false;

  const ssrf = await checkSsrf(url);
  if (!ssrf.allowed) {
    logError(`Webhook blocked by SSRF guard event=${payload.event} url=${url} reason=${ssrf.error}`);
    return false;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildWebhookBody(url, payload),
      signal: AbortSignal.timeout(10000),
      dispatcher: createPinnedDispatcher(ssrf.resolvedIp!),
    } as any);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logError(`Webhook HTTP ${res.status}: ${errBody}`);
      return false;
    }

    logInfo(`Webhook sent event=${payload.event} trip=${payload.tripName || '-'}`);
    logDebug(`Webhook url=${url} payload=${buildWebhookBody(url, payload).substring(0, 500)}`);
    return true;
  } catch (err) {
    logError(`Webhook failed event=${payload.event}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function testSmtp(to: string): Promise<{ success: boolean; error?: string }> {
  try {
    const sent = await sendEmail(to, 'Test Notification', 'This is a test email from Travel Planner. If you received this, your SMTP configuration is working correctly.');
    return sent ? { success: true } : { success: false, error: 'SMTP not configured' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function testWebhook(url: string): Promise<{ success: boolean; error?: string }> {
  try {
    const sent = await sendWebhook(url, { event: 'test', title: 'Test Notification', body: 'This is a test webhook from Travel Planner. If you received this, your webhook configuration is working correctly.' });
    return sent ? { success: true } : { success: false, error: 'Failed to send webhook' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
