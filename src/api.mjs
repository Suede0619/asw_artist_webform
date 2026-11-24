export async function request(path, method = 'GET', body, applicationId) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Intake-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(applicationId ? { 'X-Application-Id': applicationId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(result?.message || 'We couldn’t connect. Please try again.'), {
      status: response.status, fields: result?.fields,
    });
  }
  return result;
}

export function uploadImage(file, role, key, applicationId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/application/assets?role=' + role);
    xhr.setRequestHeader('X-Intake-Request', '1');
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.setRequestHeader('X-Application-Id', applicationId);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 90000;
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round(100 * event.loaded / event.total));
    });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(xhr.response?.message || 'We couldn’t upload this photo. Try again.'));
      } else {
        resolve(xhr.response);
      }
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('The upload stopped. Try this photo again.'));
    xhr.send(file);
  });
}
