# Park Race Server

Park Challenge hayalet yarışı (ghost race) için WebSocket sunucusu — **protokol 2**, her maç tam **2 oyuncu**.
Protokolün ayrıntısı Unity deposunda: `parkChallange/docs/ghost-race-contract.md`. Kurallar: `parkChallange/docs/OYUN_PLANI.md` §1 ve §4.

Gereksinim: Node.js 20+ (testler Node 24 ile çalıştırıldı).

## Kurulum ve çalıştırma

```sh
cd parkChallange-server
npm ci               # bağımlılıklar (yalnız ws)
npm start            # varsayılan port 8787
```

Windows PowerShell `npm.ps1`'i engelliyorsa `npm.cmd ci`, `npm.cmd start` kullanın.

Başlangıçta `ws://localhost:8787` ve aynı Wi-Fi'daki cihazlar için LAN adresleri (`ws://192.168.x.x:8787`) yazdırılır.

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `8787` | Dinlenen port |
| `SCORES_FILE` | `data/scores.json` (sunucu klasörüne göre) | Kalıcı puan tablosu (hızlı maç puanları, token'a göre). Git dışıdır. |
| `RACE_TIME_LIMIT_OVERRIDE` | — | **Yalnız test.** Saniye; tüm haritaların süre sınırını bununla değiştirir (`npm run e2e` kullanır). Gerçek sunucuda ayarlamayın. |

PowerShell örneği: `$env:PORT=9000; npm.cmd start` · Bash: `PORT=9000 npm start`.

## Kurallar (özet)

- **Hızlı maç:** `queue` ile sıraya giren en eski 2 oyuncu **anında** eşleşir (zamanlayıcı yok), harita rastgele, 3 sn geri sayım.
  Tek oyuncu bekler.
- **Özel oda:** 4 harfli kod, en fazla 2 kişi; geri sayım yalnız 2 oyuncu varken ve ikisi de hazırsa başlar.
- Yarış ilk sonuç olayında ikisi için de biter: park (`finish` kabul) = kazanır; 3. çarpma (`hit`) / alan dışı
  (`fail{bounds}`) / ayrılma veya kopma = rakip kazanır; süre (`timeLimit + 1 sn`) dolarsa beraberlik.
- Hızlı maçta oda kurulduğu andan (geri sayım dahil) ayrılmak veya bağlantının kopması **hükmen yenilgidir** — kaçarak
  puan kaybını engellemek için bilerek böyle seçildi. Özel odada geri sayımda ayrılmak yalnızca geri sayımı iptal eder.
- Puan yalnız hızlı maçta: galibiyet +10 (wins +1), her iki oyuncuya races +1. Özel oda ve token'sız oyuncu puan almaz.

## Test

```sh
npm test       # birim + entegrasyon testleri (node --test)
npm run e2e    # gerçek sunucu + 2 bot ile 5 senaryo; başarıda: E2E_PASSED: parked, hits, bounds, left, time
```

- `src/rooms.js` oyun mantığı saat/zamanlayıcı enjekte edilerek test edilir (`test/rooms|matchmaking|results.test.js`);
  `test/server.test.js` gerçek `ws` sunucusuyla entegrasyon testidir.
- `npm run e2e` boş bir porttan sunucuyu geçici bir `SCORES_FILE` ve `RACE_TIME_LIMIT_OVERRIDE=6` ile başlatır,
  her senaryoda 2 bot (`--queue --once`) koşturur ve `winnerId`/`reason`/puanları doğrular (~35 sn).
- Harita tablosu (Unity `RACE_MAP_TABLE` satırıyla birebir aynı olmalı):

  ```sh
  node -e "import('./src/maps.js').then(m=>console.log(Object.values(m.MAPS).map(x=>x.id+':'+x.timeLimit+':'+x.hitLimit).join(',')))"
  ```

## Bot

İkinci bir cihaz olmadan Unity istemcisini denemek için:

```sh
npm run bot -- --queue --name Bot                         # hızlı maç; her maçtan sonra tekrar sıraya girer
npm run bot -- --code ABCD --name Bot                     # özel odaya katılır
npm run bot -- --name Bot --map cone-slalom               # özel oda kurar, kodu yazdırır (ROOM CODE: ...)
npm run bot -- --queue --park 12                          # 12. saniyede park eder (kazanır)
npm run bot -- --queue --hits 3 --hit-every 2             # 2 sn arayla 3 çarpma (3.'de kaybeder)
npm run bot -- --queue --bounds 5                         # 5. saniyede alan dışına çıkar (kaybeder)
npm run bot -- --queue --leave 5                          # 5. saniyede yarıştan ayrılır (hükmen kaybeder)
npm run bot -- --queue --park none                        # hiçbir şey yapmaz, yalnız sürer (süre dolunca beraberlik)
```

| Seçenek | Açıklama |
| --- | --- |
| `--url <ws://...>` | Sunucu adresi (varsayılan `ws://localhost:8787`) |
| `--name <ad>` | Oyuncu adı (varsayılan `Bot`) |
| `--queue` | Hızlı maç sırasına girer |
| `--code <KOD>` | Özel odaya katılır; verilmezse ve `--queue` yoksa yeni oda kurar (`--map <id>`) |
| `--park <sn>` | Yarış başladıktan `sn` saniye sonra `finish` gönderir; `none` = hiç park etmez. Hiçbir senaryo seçeneği verilmezse 20 sn'de park eder |
| `--hits <n> --hit-every <sn>` | Her `sn` saniyede bir `hit` gönderir (1..n) |
| `--bounds <sn>` | `sn` saniyede `fail{reason:"bounds"}` gönderir |
| `--leave <sn>` | `sn` saniyede `leave` gönderir |
| `--once` | İlk sonuçtan (veya ayrıldıktan) sonra çıkar |
| `--x --y --r` | Ghost başlangıç konumu/açısı (varsayılan -12 -6 0) |
| `--token <t>` | Puan anahtarı (varsayılan rastgele `bot-<uuid>`) |

Bot 15 Hz `pose` gönderir (`p` park ilerlemesi park anından önceki 3 sn'de 0→1 yükselir), sonuçları
`RESULTS {...}` satırı olarak yazdırır. Özel odada rakip gelmeden hazır olmaz (geri sayım 2 hazır oyuncu ister).

## VPS'e kurulum

1. Sunucuya Node.js 20+ kurun, bu depoyu klonlayın, `npm ci --omit=dev` çalıştırın.
2. `PORT=8787 node src/index.js` komutunu systemd veya pm2 ile sürekli çalıştırın (`data/` yazılabilir olmalı).
3. Önüne bir reverse proxy (nginx/Caddy) koyup TLS'i orada sonlandırın; istemci `wss://alanadiniz.com` adresine bağlanır.
   Nginx için `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_http_version 1.1;` gerekir.

Not: `ws://` şifresizdir; yerel ağ/geliştirme için uygundur. İnternete açarken `wss://` kullanın.
