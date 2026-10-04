const OLD_HOST = 'adctoolbox.tokenzhang.com';
const OLD_ORIGIN = `https://${OLD_HOST}`;
const NEW_HOST = 'circuits-and-systems.tokenzhang.com';
const NEW_ORIGIN = 'https://circuits-and-systems.tokenzhang.com';
const RETIRED_PATHS = new Set([
  '/amplifiers/two-pole-step-response',
  '/amplifiers/two-pole-step-response/',
]);

function isTutorialPath(pathname) {
  return pathname === '/'
    || pathname === '/analytics'
    || pathname === '/analytics/'
    || pathname === '/sitemap-index.xml'
    || pathname === '/sitemap-0.xml'
    || pathname.startsWith('/adc/')
    || pathname.startsWith('/pll/')
    || pathname.startsWith('/amplifiers/')
    || pathname.startsWith('/serdes/');
}

function isManualPath(pathname) {
  return pathname === '/doc' || pathname.startsWith('/doc/');
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname === '/adc/pipeline-introduction' || url.pathname === '/adc/pipeline-introduction/') {
    const destination = new URL('/adc/pipeline-adc/' + url.search, url.hostname === OLD_HOST ? NEW_ORIGIN : url.origin);
    return Response.redirect(destination, 301);
  }

  if (RETIRED_PATHS.has(url.pathname)) {
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Lesson retired</title><body><h1>Lesson retired</h1><p>This lesson has been removed from Circuits &amp; Systems Classroom.</p><p><a href="/">Return to the classroom</a></p></body></html>', {
      status: 410,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  }

  if (url.hostname === OLD_HOST && isTutorialPath(url.pathname)) {
    const destination = new URL(url.pathname + url.search, NEW_ORIGIN);
    return Response.redirect(destination, 301);
  }

  if (url.hostname === NEW_HOST && isManualPath(url.pathname)) {
    const destination = new URL(url.pathname + url.search, OLD_ORIGIN);
    return Response.redirect(destination, 301);
  }

  return context.next();
}
