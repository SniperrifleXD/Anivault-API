import axios from 'axios';
import { anilistClient } from './fetch';
import { cacheGet, cacheSet } from './cache';
import { findAnimeHeavenId } from '../scrapers/animeheaven';
import { findAnikotoSlug } from '../scrapers/anikoto';
import { findDesidubSlug } from '../scrapers/desidub';
import { getAnimeDetails } from '../scrapers/mal';

export type MappingSource = 'animeheaven' | 'anikoto' | 'desidub' | 'megaplay';

export interface SiteIds {
  anilistId: number | null;
  malId: number | null;
  title: string;
  // Secondary title candidate (opposite of `title`'s romaji/English choice)
  // used only to retry site-matching (Anikoto/AnimeHeaven/DesiDub) when the primary
  // title doesn't score a good match. Not part of the public /info response
  // (routes.ts only ever destructures the named fields it wants).
  altTitle?: string | null;
  siteIds: {
    zoro?: string;
    gogoanime?: string;
    animeheaven?: string;
    anidao?: string;
    anikoto?: string;
    desidub?: string;
  };
}

async function enrichAnimeHeaven(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.animeheaven || result.title === 'Unknown') return result;
  const id = await findAnimeHeavenId(result.title).catch(() => null);
  if (id) {
    result.siteIds.animeheaven = id;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altId = await findAnimeHeavenId(altTitle).catch(() => null);
    if (altId) result.siteIds.animeheaven = altId;
  }
  return result;
}

// Anikoto's own site displays/searches by the localized English title, not
// the JP romaji — so callers whose `result.title` is romaji (e.g. the
// MAL-fallback path) MUST also pass the English title here, or every match
// will legitimately score too low and get rejected (see findAnikotoSlug's
// MIN_MATCH_SCORE). Tries `result.title` first, falls back to `altTitle`.
async function enrichAnikoto(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.anikoto || result.title === 'Unknown') return result;
  const slug = await findAnikotoSlug(result.title).catch(() => null);
  if (slug) {
    result.siteIds.anikoto = slug;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altSlug = await findAnikotoSlug(altTitle).catch(() => null);
    if (altSlug) result.siteIds.anikoto = altSlug;
  }
  return result;
}

async function enrichDesidub(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.desidub || result.title === 'Unknown') return result;
  const slug = await findDesidubSlug(result.title).catch(() => null);
  if (slug) {
    result.siteIds.desidub = slug;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altSlug = await findDesidubSlug(altTitle).catch(() => null);
    if (altSlug) result.siteIds.desidub = altSlug;
  }
  return result;
}

// MAL ID → AniList ID
// Returns null (never throws) if AniList is down/unreachable -- callers use
// that as the signal to fall back to the MAL-only path (getSiteIdsByMal).
export async function malToAnilist(malId: number): Promise<number | null> {
  const cacheKey = `mal2al:${malId}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached) return cached;

  try {
    const query = `query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) { id idMal title { romaji english } }
    }`;
    const res = await anilistClient.post('', { query, variables: { malId } });
    const id = res.data?.data?.Media?.id ?? null;
    if (id) cacheSet(cacheKey, id);
    return id;
  } catch {
    return null;
  }
}

// Fetch title from AniList for a given anilistId
async function getAnilistTitle(anilistId: number): Promise<{ title: string; altTitle: string | null; malId: number | null }> {
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) { idMal title { romaji english } }
  }`;
  const res = await anilistClient.post('', { query, variables: { id: anilistId } });
  const media = res.data?.data?.Media;
  const english: string | null = media?.title?.english ?? null;
  const romaji: string | null = media?.title?.romaji ?? null;
  return {
    title: english ?? romaji ?? 'Unknown',
    altTitle: english && romaji && english !== romaji ? romaji : null,
    malId: media?.idMal ?? null,
  };
}

// Enrich only the provider requested by a playback route. The no-source
// path intentionally keeps the legacy full mapping behavior used by /info.
async function enrichForSource(result: SiteIds, source?: MappingSource): Promise<SiteIds> {
  if (source === 'animeheaven') {
    await enrichAnimeHeaven(result, result.altTitle);
  } else if (source === 'anikoto') {
    await enrichAnikoto(result, result.altTitle);
  } else if (source === 'desidub') {
    await enrichDesidub(result, result.altTitle);
  } else if (!source) {
    // The legacy full-mapping path has independent provider lookups. Run
    // them concurrently rather than serializing three unrelated scrapers.
    await Promise.all([
      enrichAnimeHeaven(result, result.altTitle),
      enrichAnikoto(result, result.altTitle),
      enrichDesidub(result, result.altTitle),
    ]);
  }
  // MegaPlay needs only AniList/MAL metadata, not a site slug.
  return result;
}

// AniList ID → metadata + requested site-specific ID(s).
// Source-scoped cache entries prevent a partial lookup for one provider from
// being mistaken for a complete mapping by /info or another provider.
export async function getSiteIds(anilistId: number, source?: MappingSource): Promise<SiteIds | null> {
  const cacheKey = source ? `siteids:${anilistId}:${source}` : `siteids:${anilistId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const before = { ...cached.siteIds };
    await enrichForSource(cached, source);
    if (Object.keys(cached.siteIds).some((key) => cached.siteIds[key as keyof SiteIds['siteIds']] !== before[key as keyof SiteIds['siteIds']])) {
      cacheSet(cacheKey, cached);
    }
    return cached;
  }

  // Build result shell using AniList for the canonical title and MAL ID.
  const alInfo = await getAnilistTitle(anilistId).catch(() => ({ title: 'Unknown', altTitle: null, malId: null }));
  const result: SiteIds = {
    anilistId,
    malId: alInfo.malId,
    title: alInfo.title,
    altTitle: alInfo.altTitle,
    siteIds: {},
  };

  // Anify only supplies the legacy Zoro/GoGoAnime mappings. None of the
  // source-specific playback routes below consume those IDs, so avoid its
  // network request entirely unless the caller explicitly asks for a full
  // mapping (the existing /info contract).
  if (!source) {
    try {
      const res = await axios.get(`https://api.anify.tv/info/${anilistId}`, {
        params: { fields: 'mappings' },
        timeout: 8000,
      });
      const mappings: any[] = res.data?.mappings ?? [];
      for (const mapping of mappings) {
        if (mapping.providerId === 'zoro') result.siteIds.zoro = mapping.id;
        if (mapping.providerId === 'gogoanime') result.siteIds.gogoanime = mapping.id;
        if (mapping.providerId === 'mal' && !result.malId) result.malId = parseInt(mapping.id);
      }
    } catch {
      // Anify is optional; direct provider lookup remains available.
    }
  }

  await enrichForSource(result, source);

  // Preserve the legacy Zoro fallback only for full mapping requests.
  if (!source && !result.siteIds.zoro && result.title !== 'Unknown') {
    const slug = result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    result.siteIds.zoro = `${slug}-${anilistId}`;
  }

  cacheSet(cacheKey, result);
  return result;
}

// AniList-free fallback: build SiteIds from a MAL ID alone. Only the
// requested provider is searched, avoiding unrelated scraper work.
export async function getSiteIdsByMal(malId: number, source?: MappingSource): Promise<SiteIds | null> {
  const cacheKey = source ? `siteids:mal:${malId}:${source}` : `siteids:mal:${malId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const before = { ...cached.siteIds };
    await enrichForSource(cached, source);
    if (Object.keys(cached.siteIds).some((key) => cached.siteIds[key as keyof SiteIds['siteIds']] !== before[key as keyof SiteIds['siteIds']])) {
      cacheSet(cacheKey, cached);
    }
    return cached;
  }

  const details = await getAnimeDetails(malId).catch(() => null);
  if (!details) return null;

  // MAL's native title is often romaji; preserve the English alternative
  // because Anikoto and other providers commonly index localized titles.
  const romajiTitle = details.title || null;
  const englishTitle = details.titleEnglish || null;
  const result: SiteIds = {
    anilistId: null,
    malId,
    title: romajiTitle || englishTitle || 'Unknown',
    altTitle: englishTitle && romajiTitle && englishTitle !== romajiTitle ? englishTitle : null,
    siteIds: {},
  };

  await enrichForSource(result, source);
  cacheSet(cacheKey, result);
  return result;
}

// Search AniList by title
export async function searchAnilist(query: string): Promise<{
  id: number; malId: number | null; title: string; coverImage: string; episodes: number | null; status: string; format: string;
}[]> {
  const cacheKey = `alsearch:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const gql = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id idMal episodes
        title { romaji english }
        coverImage { large medium }
        status format
      }
    }
  }`;

  const res = await anilistClient.post('', { query: gql, variables: { search: query } });
  const list = res.data?.data?.Page?.media ?? [];

  const results = list.map((m: any) => ({
    id: m.id,
    malId: m.idMal ?? null,
    title: m.title?.english ?? m.title?.romaji,
    coverImage: m.coverImage?.large ?? m.coverImage?.medium ?? '',
    episodes: m.episodes ?? null,
    status: m.status,
    format: m.format,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}
