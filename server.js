/* ПЕРЕСЫЛЬЩИК AIYY → OpenRouter

   Зачем он нужен. OpenRouter закрывается от российских адресов: наш сервер
   в Москве получает 403 «Access denied by security policy». Значит, кто-то
   должен сходить к OpenRouter вместо него — с адреса, который тот пускает.

   Что делает эта программа. Принимает запрос от нашего сервера и слово в
   слово передаёт его в OpenRouter, а ответ возвращает обратно. Больше ничего.
   Ни ключа, ни данных людей она у себя не держит и никуда не пишет.

   Почему ключ не живёт здесь. Ключ остаётся на российском сервере и приходит
   сюда в заголовке каждого запроса, по шифрованному соединению. Так проще
   его менять и так меньше мест, где он лежит.

   Почему нужен пароль. Без него любой, кто узнает адрес пересыльщика, будет
   слать через него что угодно — и платить за это будем мы. Поэтому запрос
   без правильного заголовка X-AIYY-Relay сюда не проходит.

   Про персональные данные. Через пересыльщик идёт текст запроса к модели —
   то есть рассказ человека о своём дне. Наружу он уходил бы и так: сам
   OpenRouter находится за границей. Линия жизни, круг близких, почта и
   пропуска остаются в российской базе и сюда не попадают никогда. */

const http = require('http');

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.RELAY_SECRET || '';
const TARGET = process.env.TARGET_URL || 'https://openrouter.ai/api/v1/chat/completions';

/* Корень OpenRouter — из него собираются остальные входы: видео и список
   моделей. Выводим из TARGET, чтобы не заводить вторую настройку и не
   разъехаться с ней потом. */
const ROOT = TARGET.replace(/\/chat\/completions\/?$/i, '');

/* Тело может быть большим: в запросах на разбор дня едут фотографии. */
const LIMIT = 60 * 1024 * 1024;

function readBody(req){
  return new Promise((ok, no) => {
    const parts = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if(size > LIMIT){ no(new Error('запрос слишком большой')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}

function say(res, code, obj){
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  /* Проверка живости для панели хостинга. Ничего не рассказывает о себе. */
  if(req.url === '/health'){
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  /* ОТКРЫТАЯ СТРАНИЦА ТЕЛЕГРАМ-КАНАЛА. 5 октября, разрешение хозяина: «да давай
     попробуем». С российского сервера t.me не открывается, отсюда — да. Только
     чтение публичной страницы t.me/s/имя (то, что видит любой без входа), только
     GET, только имя канала из латиницы и цифр, только с нашим паролем. К OpenRouter
     и остальным путям (чат, видео, речь, озвучка) это не относится и их не трогает. */
  {
    const тг = /^\/tg\/([A-Za-z0-9_]{4,32})\/?$/.exec((req.url || '').split('?')[0]);
    if(тг){
      if(req.method !== 'GET') return say(res, 405, { error: 'Только чтение' });
      if(!SECRET || req.headers['x-aiyy-relay'] !== SECRET) return say(res, 403, { error: 'Нельзя' });
      try{
        const r = await fetch('https://t.me/s/' + тг[1], { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AiyyBot/1.0)' }, signal: AbortSignal.timeout(15000) });
        const html = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html.slice(0, 2000000));
      }catch(e){ say(res, 502, { error: 'Телеграм не ответил: ' + e.message }); }
      return;
    }
  }

  /* ФОТО ИЗ ПОСТА ТЕЛЕГРАМ-КАНАЛА. 5 октября, разрешение хозяина: «давай делай».
     Новости из каналов приходят без картинок: с российского сервера не открываются
     ни t.me, ни сервера картинок Телеграма. Путь /tgphoto/канал/номер открывает
     публичный пост t.me/канал/номер?embed=1, находит в нём первое фото (или обложку
     видео) и отдаёт эту картинку. Пересыльщик ходит только на t.me и на картинки
     Телеграма (telesco.pe, telegram.org, cdn-telegram.org) — никакой адрес снаружи сюда передать
     нельзя. Только GET и только с нашим паролем. */
  {
    const тф = /^\/tgphoto\/([A-Za-z0-9_]{4,32})\/(\d{1,9})\/?$/.exec((req.url || '').split('?')[0]);
    if(тф){
      if(req.method !== 'GET') return say(res, 405, { error: 'Только чтение' });
      if(!SECRET || req.headers['x-aiyy-relay'] !== SECRET) return say(res, 403, { error: 'Нельзя' });
      try{
        const ua = { 'user-agent': 'Mozilla/5.0 (compatible; AiyyBot/1.0)' };
        const r = await fetch('https://t.me/' + тф[1] + '/' + тф[2] + '?embed=1&mode=tme', { headers: ua, signal: AbortSignal.timeout(15000) });
        const html = (await r.text()).slice(0, 1500000);
        const м = /tgme_widget_message_(?:photo_wrap|video_thumb)[^>]*background-image:\s*url\(['"]?(https:\/\/[^'")\s]+)/i.exec(html);
        if(!м) return say(res, 404, { error: 'В посте нет фото' });
        const адрес = м[1].replace(/&amp;/g, '&');
        const хост = new URL(адрес).hostname.toLowerCase();
        if(!/(^|\.)(telesco\.pe|telegram\.org|telegram-cdn\.org|cdn-telegram\.org|t\.me)$/.test(хост)) return say(res, 404, { error: 'Чужой адрес картинки' });
        const к = await fetch(адрес, { headers: ua, signal: AbortSignal.timeout(15000) });
        const тип = к.headers.get('content-type') || '';
        if(!к.ok || !/^image\//i.test(тип)) return say(res, 404, { error: 'Картинка не скачалась' });
        const буф = Buffer.from(await к.arrayBuffer());
        if(буф.length > 12 * 1024 * 1024) return say(res, 413, { error: 'Слишком большая' });
        res.writeHead(200, { 'Content-Type': тип, 'Content-Length': буф.length });
        res.end(буф);
      }catch(e){ say(res, 502, { error: 'Телеграм не ответил: ' + e.message }); }
      return;
    }
  }

  /* ПРЕВЬЮ НОВОСТЕЙ ДЛЯ ТЕЛЕГРАМА (7 октября, слово хозяина: «мне бы чтобы превью показывала в Телеграме»).
     Робот Телеграма, делающий превью ссылки, до российского сервера не доходит (счётчик репостов — ноль), а сюда — доходит.
     Ссылка на новость, которой делятся, ведёт сюда: /n/<новость>. Роботу мессенджера отдаём страницу новости с aisire.ru
     (заголовок, текст, картинка — картинку тоже отсюда), живого человека сразу перекидываем на aisire.ru.
     Ходим ТОЛЬКО на свой сайт (SITE_URL, по умолчанию https://aisire.ru) и только по путям новостей; пароль не нужен —
     ровно то же самое и так открыто всем на aisire.ru. */
  {
    const путьН = (req.url || '').split('?')[0];
    const хвостН = (req.url || '').indexOf('?') >= 0 ? (req.url || '').slice((req.url || '').indexOf('?')) : '';
    const стр = /^\/n\/([a-z0-9-]{3,120})\/?$/.exec(путьН);
    const фото = /^\/n\/([a-z0-9-]{3,120})\/photo$/.exec(путьН) || /^\/(news-og\.jpg|og\.jpg|logo\.png)$/.exec(путьН);
    if((стр || фото) && req.method === 'GET'){
      const САЙТ = (process.env.SITE_URL || 'https://aisire.ru').replace(/\/+$/, '');
      const уа = String(req.headers['user-agent'] || '');
      const робот = /bot\b|bot\/|crawl|spider|preview|^whatsapp|facebookexternalhit|facebot|vkshare|viber|skype|discord|slack|twitter/i.test(уа);
      if(стр && !робот){ res.writeHead(302, { Location: САЙТ + путьН + хвостН, 'Cache-Control': 'no-store' }); return res.end(); }
      try{
        const r = await fetch(САЙТ + путьН + хвостН, { headers: { 'user-agent': уа || 'Mozilla/5.0 (compatible; AiyyRelay/1.0)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if(фото){
          const тип = r.headers.get('content-type') || '';
          if(!r.ok || !/^image\//i.test(тип)) { res.writeHead(404); return res.end(); }
          const буф = Buffer.from(await r.arrayBuffer());
          if(буф.length > 12 * 1024 * 1024){ res.writeHead(413); return res.end(); }
          res.writeHead(200, { 'Content-Type': тип, 'Content-Length': буф.length, 'Cache-Control': 'public, max-age=86400' });
          return res.end(буф);
        }
        let html = (await r.text()).slice(0, 3000000);
        /* Картинку превью — тоже отсюда: до aisire.ru робот не дотянется. */
        const мы = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(мы)){
          html = html.replace(/(<meta[^>]+(?:og:image|twitter:image)[^>]+content=")https:\/\/aisire\.ru(\/[^"]*")/gi, '$1' + мы + '$2');
        }
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(html);
      }catch(e){ res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Сайт не ответил'); }
    }
  }

  /* КЛИПЫ С YOUTUBE (7 октября, слово хозяина: «клипов мало… достань топ-плейлисты с YouTube, у большинства VPN включён»).
     С российского сервера YouTube не открывается, отсюда — да. Три пути, только GET, только с нашим паролем,
     ходим только на www.youtube.com и отдаём короткий список (номер ролика, название, канал, длина) — не страницы целиком:
       /yt/search?q=…            поиск роликов
       /yt/list/<плейлист>       ролики плейлиста
       /yt/chan/<канал>          плейлисты канала (главная и «Плейлисты») */
  {
    const путьЮ = (req.url || '').split('?')[0];
    const пЮ = /^\/yt\/(search|list|chan)(?:\/([A-Za-z0-9_-]{10,64}))?\/?$/.exec(путьЮ);
    if(пЮ){
      if(req.method !== 'GET') return say(res, 405, { error: 'Только чтение' });
      if(!SECRET || req.headers['x-aiyy-relay'] !== SECRET) return say(res, 403, { error: 'Нельзя' });
      const пар = new URL(req.url, 'http://x').searchParams;
      const gl = /^[A-Z]{2}$/.test(пар.get('gl') || '') ? пар.get('gl') : 'RU';
      const язык = '&hl=ru&gl=' + gl;
      const заг = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8', 'cookie': 'SOCS=CAI; CONSENT=YES+cb' };
      const данные = async function(адрес){
        const r = await fetch(адрес, { headers: заг, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        const html = (await r.text()).slice(0, 6000000);
        const м = /ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/.exec(html);
        if(!м) throw new Error('нет данных на странице (' + r.status + ')');
        return JSON.parse(м[1]);
      };
      const текст = function(т){ if(!т) return ''; if(typeof т === 'string') return т; if(т.simpleText) return т.simpleText; if(т.content) return т.content;
        if(Array.isArray(т.runs)) return т.runs.map(function(р){ return р.text || ''; }).join(''); return ''; };
      const обойти = function(о, f, глуб){ if(!о || typeof о !== 'object' || глуб > 60) return; if(Array.isArray(о)){ о.forEach(function(х){ обойти(х, f, глуб + 1); }); return; }
        f(о); Object.keys(о).forEach(function(к){ const з = о[к]; if(з && typeof з === 'object') обойти(з, f, глуб + 1); }); };
      const сек = function(т){ const ч = String(т || '').split(':').map(Number); if(!ч.length || ч.some(isNaN)) return 0; return ч.reduce(function(а, б){ return а * 60 + б; }, 0); };
      try{
        if(пЮ[1] === 'chan'){
          if(!/^UC[A-Za-z0-9_-]{20,}$/.test(пЮ[2] || '')) return say(res, 400, { error: 'не канал' });
          const списки = [], было = {};
          for(const хв of ['', '/playlists']){
            let д = null; try{ д = await данные('https://www.youtube.com/channel/' + пЮ[2] + хв + '?' + язык.slice(1)); }catch(e){ continue; }
            обойти(д, function(о){
              let ид = '', имя = '';
              if(о.playlistId && (о.title)){ ид = о.playlistId; имя = текст(о.title); }
              else if(о.contentId && /PLAYLIST/.test(String(о.contentType || ''))){ ид = о.contentId;
                имя = текст(о.metadata && о.metadata.lockupMetadataViewModel && о.metadata.lockupMetadataViewModel.title); }
              if(ид && имя && !было[ид] && /^(PL|OL|RD)[A-Za-z0-9_-]{10,}$/.test(ид)){ было[ид] = 1; списки.push({ id: ид, t: имя.slice(0, 160) }); }
            }, 0);
          }
          return say(res, 200, { lists: списки.slice(0, 200) });
        }
        const адрес = пЮ[1] === 'search'
          ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(String(пар.get('q') || '').slice(0, 200)) + '&sp=EgIQAQ%253D%253D' + язык
          : 'https://www.youtube.com/playlist?list=' + пЮ[2] + язык;
        if(пЮ[1] === 'search' && !пар.get('q')) return say(res, 400, { error: 'пустой поиск' });
        if(пЮ[1] === 'list' && !пЮ[2]) return say(res, 400, { error: 'нет плейлиста' });
        const д = await данные(адрес);
        const ролики = [], было = {};
        обойти(д, function(о){
          if(!о.videoId || !о.title || было[о.videoId] || !/^[A-Za-z0-9_-]{11}$/.test(о.videoId)) return;
          const имя = текст(о.title); if(!имя) return;
          было[о.videoId] = 1;
          const канал = текст(о.ownerText || о.shortBylineText || о.longBylineText);
          const дл = Number(о.lengthSeconds || 0) || сек(текст(о.lengthText));
          ролики.push({ id: о.videoId, t: имя.slice(0, 200), c: канал.slice(0, 100), len: дл, when: текст(о.publishedTimeText).slice(0, 40) });
        }, 0);
        return say(res, 200, { items: ролики.slice(0, 200) });
      }catch(e){ return say(res, 502, { error: 'YouTube не ответил: ' + e.message }); }
    }
  }

  /* ЧТО ИМЕННО ПЕРЕСЫЛАЕМ.

     19 августа. Раньше был один путь: любой POST уходил на чат-вход.
     Для видео этого мало — оно живёт своей жизнью:

       POST /videos          завести работу
       GET  /videos/{номер}  спросить, готова ли
       GET  /models          список моделей

     Поэтому теперь путь запроса переносится как есть, а разрешён
     короткий список: чужого сюда пускать нельзя, иначе пересыльщиком
     начнут ходить куда попало за наш счёт. */
  const путь = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const хвост = (req.url || '').indexOf('?') >= 0
    ? (req.url || '').slice((req.url || '').indexOf('?')) : '';

  const можно =
    (req.method === 'POST' && (путь === '/' || путь === '/chat/completions' ||
                               путь === '/videos' || путь === '/images/generations' ||
                               /* РАСШИФРОВКА РЕЧИ. 8 сентября, снимок хозяина:
                                  «Шлюз ответил 405: такой путь пересыльщик не
                                  обслуживает».

                                  Путь завели на нашей стороне 26 августа — ради
                                  субтитров, — а сюда, в список разрешённого,
                                  добавить забыли. То есть распознавание речи не
                                  работало через пересыльщика ВООБЩЕ, и якутская
                                  диктовка просто вскрыла старую дыру.

                                  Тело здесь multipart с границей: пересыльщик
                                  читает его байтами и переносит content-type
                                  как есть, поэтому файл доходит целым. */
                               путь === '/audio/transcriptions' ||
                               /* ГОЛОС ИЗ ТЕКСТА. 22 сентября, разрешение хозяина:
                                  «да» — на один новый адрес ради проверки голоса,
                                  в том числе своего по образцу. Больше в
                                  пересыльщике ничего не менялось: ответ — звук,
                                  его и так переносим байтами (audio/…). */
                               путь === '/audio/speech')) ||
    (req.method === 'GET'  && (путь === '/models' ||
                               /^\/videos\/[A-Za-z0-9_.:-]+$/.test(путь) ||
                               /* Сам файл ролика: /videos/{номер}/content.
                                  19 августа — без этого пути готовое видео
                                  качалось напрямую с openrouter.ai и упиралось
                                  в 403 по стране, то есть ровно в то, ради
                                  чего пересыльщик и поднят. */
                               /^\/videos\/[A-Za-z0-9_.:-]+\/content$/.test(путь)));

  if(!можно){
    return say(res, 405, { error: 'Такой путь пересыльщик не обслуживает' });
  }

  /* Куда пойдём у OpenRouter. Пустой путь — это чат, как было всегда. */
  const цель = (путь === '/' || путь === '/chat/completions')
    ? TARGET
    : (ROOT + путь + хвост);

  if(!SECRET){
    console.error('AIYY пересыльщик: не задан RELAY_SECRET, ничего не пропускаю');
    return say(res, 500, { error: 'Пересыльщик не настроен' });
  }

  if(req.headers['x-aiyy-relay'] !== SECRET){
    /* Молчим о причине: тот, кто стучится наугад, не должен узнать,
       что дело в заголовке, и начать его подбирать. */
    return say(res, 403, { error: 'Нельзя' });
  }

  const auth = req.headers['authorization'] || '';
  if(!auth){
    return say(res, 400, { error: 'Наш сервер не передал ключ' });
  }

  let body = null;
  if(req.method === 'POST'){
    try{ body = await readBody(req); }
    catch(e){ return say(res, 413, { error: e.message }); }
  }

  try{
    const r = await fetch(цель, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'authorization': auth,
        'x-title': 'AIYY'
      },
      body: body
    });
    /* ГОТОВЫЙ РОЛИК — ЭТО ФАЙЛ, А НЕ ТЕКСТ.

       OpenRouter отдаёт видео по ссылке вида /videos/{номер}/content.
       Прогнать его через text() значило бы испортить: двоичные данные
       не переживают превращения в строку. Поэтому всё, что не json,
       переносим байтами. */
    const тип = r.headers.get('content-type') || 'application/json; charset=utf-8';
    if(/^(video|image|audio|application\/octet-stream)/i.test(тип)){
      const буфер = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': тип, 'Content-Length': буфер.length });
      res.end(буфер);
      return;
    }
    /* ПОТОК — КУСКАМИ, А НЕ ЦЕЛИКОМ. 3 сентября. Основной сервер теперь
       просит у OpenRouter поток (stream: true), чтобы человек видел ответ
       по словам. Здесь же стояло r.text(): пересыльщик дожидался всего
       ответа и только потом отдавал — поток доезжал до сервера одним
       комом в самом конце, и от него не было толку. Событийный ответ
       переносим по мере прихода. Обрыв со стороны OpenRouter просто
       обрывает и наш ответ — сервер это распознаёт сам. */
    if(/text\/event-stream/i.test(тип)){
      res.writeHead(r.status, { 'Content-Type': тип, 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      const reader = r.body.getReader();
      try{
        while(true){
          const шаг = await reader.read();
          if(шаг.done) break;
          res.write(Buffer.from(шаг.value));
        }
      }catch(e){ console.error('AIYY пересыльщик: поток оборвался —', e.message); }
      res.end();
      return;
    }
    const text = await r.text();
    /* Отдаём как есть: и удачу, и отказ. Наш сервер сам разберёт ответ,
       а здесь любое вмешательство только запутает разбор ошибок. */
    res.writeHead(r.status, { 'Content-Type': тип });
    res.end(text);
  }catch(e){
    console.error('AIYY пересыльщик:', e.message);
    say(res, 502, { error: { message: 'Пересыльщик не достучался до OpenRouter: ' + e.message } });
  }
});

server.listen(PORT, () => {
  /* Заголовки HTTP переносят только латиницу. Пароль с кириллицей доедет
     искажённым, сверка не сойдётся, и всё будет выглядеть как «пересыльщик
     не пускает» без единой подсказки почему. */
  if(SECRET && /[^\x20-\x7E]/.test(SECRET)){
    console.error('AIYY пересыльщик: ВНИМАНИЕ — в RELAY_SECRET есть буквы вне латиницы. ' +
      'Заголовки такое не переносят: пароль не сойдётся. Возьми латиницу и цифры.');
  }
  console.log('AIYY пересыльщик на порту ' + PORT +
    (SECRET ? '' : ' — ВНИМАНИЕ: RELAY_SECRET не задан, ничего пропускать не буду'));
});
