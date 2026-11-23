// SPDX-License-Identifier: MIT

/** Runtime's inline edit field is understood by the local image server. */
export function prepareImageRequest(baseUrl, upstreamModel, body) {
  const forwarded = { ...body, model: upstreamModel };
  if (typeof body.image !== 'string' || !body.image.startsWith('data:image/')) return forwarded;
  if (new URL(baseUrl).hostname !== 'openrouter.ai') return forwarded;
  if (body.input_references != null && !Array.isArray(body.input_references)) return forwarded;
  delete forwarded.image;
  forwarded.input_references = [
    ...(body.input_references ?? []),
    { type: 'image_url', image_url: { url: body.image } }
  ];
  return forwarded;
}
