export const onRequest: PagesFunction = async () => {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appID: 'DYAAM5G8JF.red.sentry.app.SENTRY-Messenger',
          // 使用通配符允許所有路徑，以涵蓋實際 NDEF URL。
          paths: ['*']
        }
      ]
    }
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'max-age=3600'
    }
  });
};
