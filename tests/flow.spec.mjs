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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We’d like to feature your work in our first edition.');
  await expect(page.getByText('20% commission on completed artwork sales through the website')).toBeVisible();
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /an open blue door/i })).toHaveAttribute('src', '/adobe-door.jpg');
  await expect(page.getByRole('link', { name: 'Privacy and submissions' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/invitation-desktop.png', fullPage: true });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('link', { name: 'Request a call' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Talk with us');
  await page.getByLabel('Name').fill('Preview Callback Artist');
  await page.getByLabel('Phone number').fill('505 555 0119');
  await page.getByLabel('You may call me about this invitation.').check();
  await page.getByRole('button', { name: 'Request a call' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We received your request');
  await expect(page.getByText('Thank you. We’ll call you at the number you shared.')).toBeVisible();
  await page.goto('/review');
  await expect(page.getByRole('banner')).toHaveCount(0);
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
    const applyUrl = base + '/apply?campaign=taos-artists';
    await page.goto(base + '/?campaign=taos-artists');
    await page.screenshot({ path: 'test-results/invitation-mobile.png', fullPage: true });
    await page.getByRole('link', { name: 'Start my submission' }).click();
    await expect(page).toHaveURL(applyUrl);
    await expect(page.getByRole('heading', { name: 'Artist profile', exact: true })).toBeVisible();
    await page.getByLabel('Email address').fill('artist@example');

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
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Artwork', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save and exit' }).click();
    await expect(page.getByText('Your draft is saved. Return in this browser to continue.')).toBeVisible();
    await page.getByRole('link', { name: 'Continue my submission' }).click();
    await expect(page.getByRole('heading', { name: 'Artwork', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Email address')).toHaveValue('artist@example');
    await expect(page.getByLabel('Short artist bio')).toHaveValue('I make test artworks for this fictional submission.');
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Manage submission' }).click();
    await page.getByRole('button', { name: 'Email me a private link' }).click();
    await expect(page.getByText('Check your email for a private link to your submission.')).toBeVisible();

    const resumed = await second.newPage();
    resumed.on('pageerror', (error) => errors.push(error.message));
    const linkDirectory = join(process.env.ASW_BROWSER_DATA, 'dev-mail');
    await resumed.goto(await latestLink(email));
    await resumed.getByRole('button', { name: 'Open my submission' }).click();
    await expect(resumed.getByRole('heading', { name: 'Artwork', exact: true })).toBeVisible();
    await resumed.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(resumed.getByLabel('Artist name')).toHaveValue('Mobile Test Artist');
    await expect(resumed.getByLabel('Portrait credit')).toHaveValue('Fictional credit');
    await resumed.getByRole('button', { name: 'Continue' }).click();
    await expect(resumed.getByRole('heading', { name: 'Artwork', exact: true })).toBeVisible();

    for (let i = 1; i <= 3; i++) {
      await resumed.getByRole('button', { name: 'Add a work' }).click();
      const work = resumed.locator('.work-body');
      await expect(work.getByLabel('Title')).toBeFocused();
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
    await resumed.getByLabel('I have permission to submit these materials.').check();
    await resumed.getByLabel(/I understand that ArtSouthwest charges a 20% commission/).check();
    await expect(resumed.locator('a[href="/privacy"]')).toHaveCount(0);
    const submit = resumed.getByRole('button', { name: 'Submit my work' });
    await submit.click();
    await expect(resumed.getByText('The artist’s permission is required to publish the profile and artwork.')).toBeVisible();
    await resumed.getByLabel(/I give ArtSouthwest permission/).check();
    await submit.click();
    await expect(resumed.getByRole('heading', { level: 1 })).toHaveText('We received your work');
    await expect(resumed.getByText(/will review it before your profile and artwork appear on ArtSouthwest/)).toBeVisible();
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
