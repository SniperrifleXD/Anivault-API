import axios from 'axios';
import { resolveMegaPlayPlayerFromHtml } from './anikoto';

export interface MegaPlayStream {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles: { lang: string; url: string; default?: boolean }[];
  serverName: string;
  type: 'hls' | 'iframe';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Fetch the direct MAL/AniList player endpoint and resolve its player page. */
export async function getMegaPlayStream(
  malId: number | null | undefined,
  anilistId: number | null | undefined,
  episode: number,
  language: 'sub' | 'dub' | 'raw'
): Promise<MegaPlayStream | null> {
  if (!Number.isInteger(episode) || episode < 1) return null;
  const idKind = malId && Number(malId) > 0 ? 'mal' : anilistId && Number(anilistId) > 0 ? 'ani' : null;
  const id = idKind === 'mal' ? Number(malId) : Number(anilistId);
  if (!idKind || !Number.isInteger(id) || id <= 0) return null;

  const playerUrl = `https://megaplay.buzz/stream/${idKind}/${id}/${episode}/${encodeURIComponent(language)}`;
  try {
    const response = await axios.get<string>(playerUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://megaplay.buzz/',
      },
      timeout: 12000,
      maxRedirects: 5,
    });
    const finalUrl = (response.request as any)?.res?.responseUrl || playerUrl;
    const html = typeof response.data === 'string' ? response.data : '';
    if (!html || !/<html|<iframe|<title/i.test(html)) return null;

    // The shared extractor fetches the player itself and decrypts the returned
    // sources.enc payload, including any required playback URL token.
    const stream = await resolveMegaPlayPlayerFromHtml(finalUrl, html);
    if (!stream) return null;
    return { ...stream, embedUrl: stream.embedUrl || finalUrl };
  } catch (error: any) {
    console.error('[megaplay] direct player resolution failed', {
      playerUrl,
      status: error?.response?.status,
      message: error?.message || String(error),
    });
    return null;
  }
}
