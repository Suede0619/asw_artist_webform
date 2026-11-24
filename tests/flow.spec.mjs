import { expect, test, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const exampleImage = (width) => sharp({ create: {
  width, height: 720, channels: 3, background: '#bf8572',
} }).jpeg().toBuffer();

async function latestLink(email) {
  const dir = join(process.env.ASW_BROWSER_DATA, 'dev-mail');
  let link;
  await expect.poll(async () => {
    try {
      for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json'))) {
        const message = JSON.parse(await readFile(join(dir, file)));
        if (message.to === email) link = message.text.match(/http:\/\/127\.0\.0\.1:4187\/resume#[\w-]+/)?.[0] || link;
      }
    } catch { /* The worker may not have written the file yet. */ }
    return Boolean(link);
  }, { timeout: 12_000 }).toBe(true);
  return link;
}

test('desktop invitation and callback make the correct offer and save the request', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?campaign=taos-artists');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('An invitation to show your work');
  await expect(page.getByText('20% commission on artwork sold through the platform')).toBeVisible();
  await page.screenshot({ path: 'test-results/invitation-desktop.png', fullPage: true });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('link', { name: 'Request a call' }).click();
  await page.getByLabel('Name').fill('Preview Callback Artist');
  await page.getByLabel('Phone number').fill('505 555 0119');
  await page.getByLabel('You may call me about this invitation.').check();
  await page.getByRole('button', { name: 'Request a call' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We received your request');
  await page.goto('/review');
  await page.getByLabel('Review desk password').fill('fictional-review-password-for-browser-test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Call requests', exact: true }).click();
  const result = page.getByRole('article').filter({ hasText: 'Preview Callback Artist' });
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: 'Mark called' }).click();
  await expect(result.getByText(/completed/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('iPhone-sized flow resumes across browser contexts, validates uploads, and submits three works', async ({ browser }) => {
  const { defaultBrowserType, ...mobileSettings } = devices['iPhone 13'];
  void defaultBrowserType;
  const first = await browser.newContext(mobileSettings);
  const second = await browser.newContext(mobileSettings);
  try {
    const errors = [];
    const page = await first.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const base = 'http://127.0.0.1:4187';
    const email = 'mobile-' + randomUUID().slice(0, 8) + '@example.test';
    await page.goto(base + '/?campaign=taos-artists');
    await page.screenshot({ path: 'test-results/invitation-mobile.png', fullPage: true });
    await page.getByRole('link', { name: 'Start my submission' }).click();
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Email me a private link' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    const originalLink = await latestLink(email);
    await page.goto(originalLink);
    await page.getByRole('button', { name: 'Open my submission' }).click();

    await page.getByLabel('Artist name').fill('Mobile Test Artist');
    await page.getByLabel('Phone number').fill('(505) 555-0112');
    await page.getByLabel('City or town').fill('Taos');
    await page.getByLabel('Short artist bio').fill('I make test artworks for this fictional submission.');
    const portrait = page.getByLabel('Upload a portrait');
    await portrait.setInputFiles({ name: 'undersize.jpg', mimeType: 'image/jpeg', buffer: await exampleImage(1079) });
    await expect(page.getByRole('alert')).toContainText('1,080 pixels');
    const image = await exampleImage(1080);
    await portrait.setInputFiles({ name: 'test-photo.jpg', mimeType: 'image/jpeg', buffer: image });
    await page.getByLabel('Portrait credit').fill('Fictional credit');
    await page.getByLabel('I have permission to share this portrait for review.').check();
    await page.getByRole('button', { name: 'Save and exit' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Resume your submission');

    const resumed = await second.newPage();
    resumed.on('pageerror', (error) => errors.push(error.message));
    await resumed.goto(base + '/start?resume=1');
    await resumed.getByLabel('Email address').fill(email);
    await resumed.getByRole('button', { name: 'Email me a private link' }).click();
    await expect(resumed.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    const linkDirectory = join(process.env.ASW_BROWSER_DATA, 'dev-mail');
    let resumeLinks;
    await expect.poll(async () => {
      resumeLinks = [];
      for (const file of (await readdir(linkDirectory)).filter((name) => name.endsWith('.json'))) {
        const message = JSON.parse(await readFile(join(linkDirectory, file)));
        const url = message.text.match(/http:\/\/127\.0\.0\.1:4187\/resume#[\w-]+/)?.[0];
        if (url && message.to === email) resumeLinks.push(url);
      }
      return resumeLinks.length;
    }, { timeout: 12_000 }).toBe(2);
    await resumed.goto(resumeLinks.find((candidate) => candidate !== originalLink));
    await resumed.getByRole('button', { name: 'Open my submission' }).click();
    await expect(resumed.getByLabel('Artist name')).toHaveValue('Mobile Test Artist');
    await expect(resumed.getByLabel('Portrait credit')).toHaveValue('Fictional credit');
    await resumed.getByRole('button', { name: 'Continue' }).click();
    await expect(resumed.getByRole('heading', { name: 'Artwork', exact: true })).toBeVisible();

    for (let i = 1; i <= 3; i++) {
      await resumed.getByRole('button', { name: 'Add a work' }).click();
      const work = resumed.locator('.work-body');
      await work.getByLabel('Title').fill('Fictional work ' + i);
      await work.getByLabel('About this work').fill('A fictional work for the test.');
      await work.getByLabel('Medium or materials').fill('Oil on paper');
      await work.getByLabel('Height').fill('10');
      await work.getByLabel('Width').fill('12');
      await work.getByLabel('Units').selectOption('in');
      await work.getByLabel('Retail price (USD)').fill('125.00');
      await work.getByLabel('Available for sale').selectOption('available');
      await work.getByLabel('Who handles the sale?').selectOption('artist');
      await work.getByLabel('Upload a photo of this work').setInputFiles({ name: 'work.jpg', mimeType: 'image/jpeg', buffer: image });
      await work.getByLabel('Photo 1 credit').fill('Fictional credit');
      await work.getByLabel('I can share this work and its photos for review.').check();
    }
    await resumed.getByRole('button', { name: 'Continue' }).click();
    await expect(resumed.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await resumed.getByLabel('I have permission to share these materials for review.').check();
    await resumed.getByLabel(/I understand that Southwest Arts charges a 20% commission/).check();
    await resumed.getByRole('button', { name: 'Send my work for review' }).click();
    await expect(resumed.getByRole('heading', { level: 1 })).toHaveText('We received your work');
    const noOverflow = await resumed.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    expect(errors).toEqual([]);
    await expect.poll(async () => {
      for (const file of (await readdir(linkDirectory)).filter((name) => name.endsWith('.json'))) {
        const message = JSON.parse(await readFile(join(linkDirectory, file)));
        if (message.to === email && message.subject.includes('received')) return true;
      }
      return false;
    }, { timeout: 12_000 }).toBe(true);
  } finally {
    await first.close();
    await second.close();
  }
});
