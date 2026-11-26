import { z } from 'zod';

const optional = max => z.string().trim().max(max).default('');
const required = max => z.string().trim().min(1).max(max);
const timezone = 'America/Denver';
const denver = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export const denverTime = (date = new Date()) => {
  const parts = Object.fromEntries(denver.formatToParts(date).map(({ type, value }) => [type, value]));
  return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
};
export const offsetDate = (date, days) => {
  const utc = new Date(date.slice(0, 10) + 'T12:00:00Z');
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
};
export const isIssueDate = date => new Date(date + 'T12:00:00Z').getUTCDay() === 4;
export function artistMarket(profile) {
  const locality=String(profile.city).split(',')[0].replace(/\s+NM\.?$/i,'').trim();
  if (/^santa fe$/i.test(locality)) return 'santa-fe';
  if (/^(taos|el prado|arroyo seco|ranchos de taos|taos ski valley)$/i.test(locality)) return 'taos';
  return '';
}
export const startsThisWeek = (row, day, end) => row.startDate <= end && row.endDate >= day;
export const expired = (row, when) => row.endDate < when.slice(0, 10) ||
  (row.kind !== 'exhibition' && row.endDate === when.slice(0, 10) && row.endTime <= when.slice(11));

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
const link = z.string().trim().max(480).refine(httpsUrl, 'Enter an HTTPS address.').transform(httpsUrl);
const time = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const optionalTime = time.or(z.literal('')).default('');
const publicSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(110);
const picture = {
  imageAlt: required(180),
  imageCredit: optional(180),
  imageRights: z.literal(true),
};
export const calendarFields = z.object({
  city: z.enum(['taos','santa-fe']),
  kind: z.enum(['exhibition','opening','event']),
  title: required(130), venue: required(140), startDate: z.iso.date(),
  endDate: z.iso.date(), startTime: optionalTime, endTime: optionalTime,
  summary: required(900), source: link, admission: optional(150),
  scheduleStatus: z.enum(['scheduled','rescheduled','canceled','postponed']).default('scheduled'),
  relatedTitle: optional(130), relatedId: z.uuid().or(z.literal('')).default(''),
  artistSlug: publicSlug.or(z.literal('')).default(''),
}).superRefine((row, ctx) => {
  if (row.startDate > row.endDate) ctx.addIssue({ code:'custom', path:['endDate'], message:'Choose an ending date on or after the start.' });
  if (row.kind !== 'exhibition' && (!row.startTime || !row.endTime ||
    row.startDate === row.endDate && row.startTime >= row.endTime)) {
    ctx.addIssue({ code:'custom', path:['endTime'], message:'Give a start time and a later end time for the event.' });
  }
});
export const calendarSubmission = z.object({
  ...calendarFields.shape, ...picture,
  contact: z.email().max(254),
}).superRefine((row, ctx) => {
  const result = calendarFields.safeParse(row);
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue(issue);
});
export const sponsorSubmission = z.object({
  organization: required(120), contact: z.email().max(254),
  issueDate: z.iso.date().refine(isIssueDate, 'Choose a Thursday issue.'),
  title: required(85), summary: required(250), destination: link,
  ...picture,
});
