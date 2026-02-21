// index.html — JS redirect fallback
try { location.replace('/pages/login.html'); }
catch(e) { location.href = '/pages/login.html'; }
