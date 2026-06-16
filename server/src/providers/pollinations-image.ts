import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError } from './base.js';

/**
 * Pollinations image generation provider (keyless, anonymous tier).
 *
 * Endpoint: GET https://image.pollinations.ai/prompt/{prompt}?model=...&width=...&height=...
 * Returns a raw image (Content-Type: image/jpeg or image/png). We either:
 *  - return the direct URL (response_format='url', default) — fastest, no buffering
 *  - download and base64-encode (response_format='b64_json')
 *
 * Anonymous tier is queue-limited (1 concurrent request per IP). 429 surfaces
 * as a retryable provider error via providerHttpError so the router can bench
 * this key briefly if/when image routing gains failover. (Today this provider
 * is the sole image backend, so 429s pass through to the client.)
 *
 * Chat methods deliberately throw — this adapter is image-only. The platform
 * is registered as 'pollinations-image' (separate from 'pollinations' text)
 * so the existing text catalog stays untouched.
 */
export class PollinationsImageProvider extends BaseProvider {
  readonly platform = 'pollinations-image' as const;
  readonly name = 'Pollinations (Image)';
  keyless = true;

  async chatCompletion(): Promise<never> {
    throw new Error('Pollinations (Image) is image-only; use /v1/images/generations');
  }

  async *streamChatCompletion(): AsyncGenerator<never> {
    throw new Error('Pollinations (Image) is image-only; use /v1/images/generations');
  }

  async validateKey(_apiKey: string): Promise<boolean> {
    const res = await this.fetchWithTimeout(
      'https://image.pollinations.ai/prompt/test?width=64&height=64&nologo=true',
      { method: 'GET' },
      10000,
    );
    return res.ok;
  }

  supportsImages(): boolean { return true; }

  async generateImage(
    _apiKey: string,
    req: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse> {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error('prompt is required');

    const model = (req.model && req.model !== 'auto') ? req.model : 'flux';
    const n = Math.max(1, Math.min(req.n ?? 1, 4));

    let width = 1024, height = 1024;
    if (typeof req.size === 'string' && /^\d+x\d+$/.test(req.size)) {
      const [w, h] = req.size.split('x').map(Number);
      width = w; height = h;
    }

    const seedBase = typeof req.seed === 'number' ? req.seed : Math.floor(Math.random() * 1_000_000_000);
    const format: 'url' | 'b64_json' = req.response_format === 'b64_json' ? 'b64_json' : 'url';

    const buildUrl = (seed: number) => {
      const params = new URLSearchParams({
        model,
        width: String(width),
        height: String(height),
        seed: String(seed),
        nologo: 'true',
        safe: 'false',
      });
      return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
    };

    const data: ImageGenerationResponse['data'] = [];
    for (let i = 0; i < n; i++) {
      const url = buildUrl(seedBase + i);
      if (format === 'url') {
        data.push({ url });
      } else {
        const res = await this.fetchWithTimeout(url, { method: 'GET' }, 60000);
        if (!res.ok) {
          throw providerHttpError(res, `Pollinations image error ${res.status}: ${res.statusText}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        data.push({ b64_json: buf.toString('base64') });
      }
    }

    return {
      created: Math.floor(Date.now() / 1000),
      data,
      _routed_via: { platform: 'pollinations-image', model },
    };
  }
}
