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
                               путь === '/videos' || путь === '/images/generations')) ||
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
