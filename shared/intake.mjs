import { z } from 'zod';

export function catalogMarket(city) {
  const locality=String(city).split(',')[0].replace(/\s+NM\.?$/i,'').trim();
  if (/^santa fe$/i.test(locality)) return 'santa-fe';
  if (/^(taos|el prado|arroyo seco|arroyo hondo|ranchos de taos|taos ski valley|rinconada)$/i.test(locality)) return 'taos';
  return '';
}

export const POLICY_VERSION = '2026-11-23-v2';
export const COMMISSION = 20;
export const SUBMISSION_RECEIPT = 'Thank you for sharing your work. We’ve received your submission. Our team will review it before your profile and artwork appear on ArtSouthwest.';
export const MIN_EDGE = 1080;
export const MAX_BYTES = 12 * 1024 * 1024;
export const MAX_PIXELS = 52_000_000;
export const MIN_WORKS = 3;
export const MAX_WORKS = 5;
export const MAX_WORK_IMAGES = 4;

const text = (max) => z.string().max(max);
const blankOrUuid = z.union([z.uuid(), z.literal('')]);
const image = z.object({ id: z.uuid(), credit: text(160), alt: text(250) });
const profile = z.object({
  name: text(120), email: text(254).optional(), phone: text(32), city: text(120), region: text(100),
  bio: text(1800), pronouns: text(60), website: text(350), contactLink: text(350),
  studio: text(500), portrait: image.nullable(), portraitRights: z.boolean(),
});
const work = z.object({
  id: z.uuid(), title: text(150), story: text(1500), medium: text(180), year: text(30),
  shape: z.enum(['flat', 'three-dimensional']), height: text(20), width: text(20), depth: text(20),
  units: z.enum(['', 'in', 'cm']), price: text(20), currency: z.literal('USD'),
  availability: z.enum(['', 'available', 'sold']),
  seller: z.enum(['', 'artist', 'gallery']), galleryName: text(150), galleryContact: text(350),
  edition: text(150), location: text(150), delivery: text(500), restrictions: text(500),
  images: z.array(image).max(MAX_WORK_IMAGES), rights: z.boolean(),
});
export const draftSchema = z.object({
  profile,
  works: z.array(work).max(MAX_WORKS),
  permissions: z.object({
    review: z.boolean(), publicUse: z.boolean(), commission: z.boolean(), limitations: text(800),
  }),
  step: z.enum(['profile', 'works', 'review']),
});

export const cleanEmail = z.string().trim().toLowerCase().max(254).email();
export const revisionSchema = z.number().int().positive();
export const saveSchema = z.object({ revision: revisionSchema, draft: draftSchema });
export const callbackSchema = z.object({
  key: z.uuid(), name: z.string().trim().min(1).max(120), phone: z.string().trim().max(32),
  bestTime: z.string().trim().max(150), question: z.string().trim().max(600), consent: z.literal(true),
  campaign: z.string().optional(),
});
export const reportSchema = z.object({
  key: z.uuid(),
  kind: z.enum(['sale', 'correction', 'withdrawal']),
  workId: blankOrUuid.optional(),
  note: z.string().trim().max(1200).optional(),
});
export const reviewerActionSchema = z.object({
  revision: revisionSchema, action: z.enum(['changes', 'publish', 'pause']),
  note: z.string().trim().max(1600), clearance: z.boolean().optional(),
});

export function emptyDraft() {
  return {
    profile: {
      name: '', email: '', phone: '', city: '', region: 'New Mexico', bio: '',
      pronouns: '', website: '', contactLink: '', studio: '', portrait: null, portraitRights: false,
    },
    works: [],
    permissions: { review: false, publicUse: false, commission: false, limitations: '' },
    step: 'profile',
  };
}

export function emptyWork(id) {
  return {
    id, title: '', story: '', medium: '', year: '', shape: 'flat', height: '',
    width: '', depth: '', units: '', price: '', currency: 'USD', availability: '',
    seller: '', galleryName: '', galleryContact: '', edition: '', location: '',
    delivery: '', restrictions: '', images: [], rights: false,
  };
}

export function normalPhone(value) {
  const digits = value.replace(/\D/g, '');
  if (!/^\+?[\d() .-]+$/.test(value.trim()) || digits.length < 10 || digits.length > 15) return '';
  if (digits.length === 10 && !value.trim().startsWith('+')) return '+1' + digits;
  return '+' + digits;
}

export function trustedLink(input) {
  const value = input.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function cents(input) {
  const value = input.trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return amount > 0 ? amount : null;
}

function validSize(value) {
  const n = Number(value);
  return /^\d{1,5}(\.\d{1,4})?$/.test(value.trim()) && n > 0 && n <= 10000;
}

export function checkDraft(draft, { publishing = false, checkEmail = true } = {}) {
  const issues = {};
  const need = (path, value, note) => { if (!value) issues[path] = note; };
  const { profile: p, works, permissions } = draft;
  need('profile.name', p.name.trim(), 'Enter the name you want on your profile.');
  if (checkEmail) need('profile.email', cleanEmail.safeParse(p.email).success, 'Enter a valid email address.');
  need('profile.phone', normalPhone(p.phone), 'Enter a phone number with its area code.');
  need('profile.city', p.city.trim(), 'Enter your city or town.');
  need('profile.region', p.region.trim(), 'Enter your state or region.');
  need('profile.bio', p.bio.trim(), 'Write a short artist bio.');
  for (const [field, label] of [['website', 'artist website'], ['contactLink', 'public inquiry link']]) {
    if (p[field].trim()) need('profile.' + field, trustedLink(p[field]), 'Enter a full web address for your ' + label + '.');
  }
  need('profile.portrait', p.portrait, 'Add a portrait.');
  if (p.portrait) need('profile.portrait.credit', p.portrait.credit.trim(), 'Enter the portrait photo credit.');
  need('profile.portraitRights', p.portraitRights, 'Confirm you may share the portrait for review.');

  const liveWorks = publishing ? works.filter((item) => item.availability !== 'sold') : works;
  need('works', liveWorks.length >= MIN_WORKS && works.length <= MAX_WORKS,
    'Include three to five available works. Remove or replace a work that has sold.');
  const ids = new Set();
  const usedMedia = new Set(p.portrait ? [p.portrait.id] : []);
  for (const w of liveWorks) {
    const key = 'work.' + w.id + '.';
    need('works', !ids.has(w.id), 'Each work needs its own entry.');
    ids.add(w.id);
    need(key + 'title', w.title.trim(), 'Enter a title, or enter Untitled.');
    need(key + 'story', w.story.trim(), 'Describe the work in a few sentences.');
    need(key + 'medium', w.medium.trim(), 'Enter the medium or materials.');
    need(key + 'height', validSize(w.height), 'Enter a positive height.');
    need(key + 'width', validSize(w.width), 'Enter a positive width.');
    if (w.shape === 'three-dimensional' || w.depth.trim()) {
      need(key + 'depth', validSize(w.depth), 'Enter a positive depth.');
    }
    need(key + 'units', w.units, 'Choose inches or centimeters.');
    need(key + 'price', cents(w.price), 'Enter a positive USD price with up to two decimal places.');
    need(key + 'availability', w.availability === 'available', 'Confirm the work is currently available.');
    need(key + 'seller', w.seller, 'Choose who handles this sale.');
    if (w.seller === 'gallery') need(key + 'galleryName', w.galleryName.trim(), 'Enter the representing gallery.');
    need(key + 'images', w.images.length, 'Add a photo of this work.');
    for (const [index, media] of w.images.entries()) {
      need(key + 'image.' + index + '.credit', media.credit.trim(), 'Enter a photo credit.');
      need(key + 'image.' + index, !usedMedia.has(media.id), 'Use a separate file for each image.');
      usedMedia.add(media.id);
    }
    need(key + 'rights', w.rights, 'Confirm you may share this work and its images for review.');
  }
  need('permissions.review', permissions.review, 'Confirm you have permission to submit these materials.');
  need('permissions.publicUse', permissions.publicUse, 'The artist’s permission is required to publish the profile and artwork.');
  need('permissions.commission', permissions.commission, 'Acknowledge the commission disclosure.');
  return issues;
}

export function campaignId(value) {
  return value === 'taos-artists' ? 'taos-artists' : 'direct';
}
