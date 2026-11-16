// pull-playlists.ts
// Holt alle Playlists aus deiner Apple-Music-Bibliothek inkl. Songs
// und ergänzt pro Song die vollen Katalog-Metadaten. Ergebnis: playlists.json
//
// Benötigt zwei Umgebungsvariablen (NICHT in den Code schreiben):
//   APPLE_DEV_TOKEN   -> der Bearer-Token (eyJ0eXAi...), den dir der Scraper liefert
//   APPLE_USER_TOKEN  -> dein media-user-token aus dem Browser-Cookie
// Optional:
//   APPLE_STOREFRONT  -> Ländercode, Standard: de

import { writeFile } from 'node:fs/promises';

const BASE = 'https://amp-api.music.apple.com';
const DEV_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkzOTAwNzA4LCJleHAiOjE3OTk5NDg3MDgsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.7L-PYJHjO8PpFdhKS-OSkf_snyFvg5cq-JDERUs_N_UcUX9Vk0kf1WLatgDeEvhB_Arg1b5Tl-99G1v6hUwH0A";
const USER_TOKEN = "0.Aq2pUPKYRV3jhOZu+ogh0uh2NvphXIz7yLGKVfsoddDYRB/vF+Sm8kOvsAjDdOEQgIVHowlJs4F/FwyKtQCZGQpTWpnykUvWSxtvp/hNow09WyRBIBG8XVUdkWq9lx9Hu6lYOThqFGGKH0vU4Me5J4NlkLHMVGcnRs/R72ofEXKqmVEaxQz4NivDnVrJq4YDdrb+Hto5irTvSp0Ot/PKiknoK57U90OUaVooqbvZAv9Sf/dJUw==";
const STOREFRONT = process.env.APPLE_STOREFRONT ?? 'de';

if (!DEV_TOKEN) throw new Error('APPLE_DEV_TOKEN ist nicht gesetzt');
if (!USER_TOKEN) throw new Error('APPLE_USER_TOKEN ist nicht gesetzt');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Eine Anfrage an die API (mit einfachem Retry bei 429 = zu viele Anfragen)
async function apiGet(path: string, retries = 3): Promise<any> {
    const res = await fetch(BASE + path, {
        headers: {
            Authorization: `Bearer ${DEV_TOKEN}`,
            'Music-User-Token': USER_TOKEN!,
            Origin: 'https://music.apple.com',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
    });

    if (res.status === 429 && retries > 0) {
        await sleep(2000);
        return apiGet(path, retries - 1);
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} bei ${path}`);
    }
    return res.json();
}

// Alle Seiten eines Endpunkts einsammeln (Apple liefert max. ~100 pro Seite)
async function getAll(path: string): Promise<any[]> {
    const items: any[] = [];
    let next: string | undefined = path;
    while (next) {
        const json = await apiGet(next);
        items.push(...(json.data ?? []));
        next = json.next; // undefined, wenn es keine weitere Seite gibt
    }
    return items;
}

// Songs aus dem Katalog in Blöcken nachladen -> Map von Katalog-ID zu Song
async function getCatalogSongs(ids: string[]): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    const unique = [...new Set(ids)];

    for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100).join(',');
        try {
            const json = await apiGet(
                `/v1/catalog/${STOREFRONT}/songs?ids=${chunk}&include=albums,artists`
            );
            for (const song of json.data ?? []) map.set(song.id, song);
        } catch (e) {
            console.warn(`  Katalog-Block ab ${i} fehlgeschlagen:`, String(e));
        }
        await sleep(200); // kleine Pause, um nicht ins Rate-Limit zu laufen
    }
    return map;
}

async function main() {
    console.log('Hole Playlists ...');
    const playlists = await getAll('/v1/me/library/playlists?limit=100');
    console.log(`${playlists.length} Playlists gefunden.\n`);

    const result: any[] = [];

    for (const [index, pl] of playlists.entries()) {
        const name = pl.attributes?.name ?? '(ohne Name)';
        console.log(`[${index + 1}/${playlists.length}] ${name}`);

        // Songs der Playlist; leere Playlists liefern teils einen Fehler
        let tracks: any[] = [];
        try {
            tracks = await getAll(`/v1/me/library/playlists/${pl.id}/tracks?limit=100`);
        } catch (e) {
            console.warn('  Songs konnten nicht geladen werden:', String(e));
        }

        // Katalog-IDs der Songs sammeln und volle Metadaten holen
        const catalogIds = tracks
            .map((t) => t.attributes?.playParams?.catalogId)
            .filter((id): id is string => Boolean(id));
        const catalog = await getCatalogSongs(catalogIds);

        result.push({
            id: pl.id,
            name,
            attributes: pl.attributes,
            trackCount: tracks.length,
            tracks: tracks.map((t) => {
                const catalogId = t.attributes?.playParams?.catalogId;
                return {
                    libraryId: t.id,
                    catalogId: catalogId ?? null,
                    library: t.attributes,                       // Daten aus deiner Bibliothek
                    catalog: catalogId ? catalog.get(catalogId) ?? null : null, // volle Katalog-Metadaten
                };
            }),
        });

        await sleep(200);
    }

    await writeFile('playlists.json', JSON.stringify(result, null, 2), 'utf8');
    console.log('\nFertig. Gespeichert in playlists.json');
}

main().catch((e) => {
    console.error('Fehler:', e);
    process.exit(1);
});