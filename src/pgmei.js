// Núcleo da automação de emissão do DAS (PGMEI) usando Playwright.
//
// Fluxo automatizado:
//   1. Acessa a página de identificação do PGMEI
//   2. Preenche o CNPJ e clica em "Continuar"  (aqui há hCaptcha invisível)
//   3. Seleciona "Emitir Guia de Pagamento (DAS)"
//   4. Seleciona o ano-calendário e clica em "Ok"
//   5. Marca o período de apuração (mês) e clica em "Apurar/Gerar DAS"
//   6. Extrai o nome do contribuinte e baixa o PDF da guia
//
// CAPTCHA: o portal usa hCaptcha invisível que detecta e BLOQUEIA navegadores
// controlados por automação (Playwright/Selenium) — nem exibe desafio, só
// recusa ("Comportamento de Robô"). Por isso o modo recomendado é 'chrome':
// a ferramenta abre o SEU Chrome/Edge real (sem flags de automação) e se
// CONECTA a ele via CDP. Assim o hCaptcha vê um navegador normal; você resolve
// a identificação/captcha (uma vez) e a automação assume o resto.
//
// Exporta: emitirDAS(opts) => { pdfPath, fileName, nome, valor, periodo }

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const BASE = 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app';
const URL_IDENTIFICACAO = `${BASE}/Identificacao`;
const URL_EMISSAO = `${BASE}/emissao`;
const URL_IMPRIMIR = `${BASE}/emissao/imprimir`;
const SELETOR_MENU_EMISSAO = 'a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao"]';

const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Erro específico de bloqueio por captcha (permite fallback para modo assistido). */
export class CaptchaBloqueado extends Error {
  constructor(msg) { super(msg); this.name = 'CaptchaBloqueado'; }
}

// ---------------------------------------------------------------------------
// Descoberta de navegador / ambiente
// ---------------------------------------------------------------------------

/** Executável do Chromium empacotado (usado pelos modos headless/headful/assistido). */
function resolverExecutavel() {
  const explicito = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicito && fs.existsSync(explicito)) return explicito;
  const doAmbiente = '/opt/pw-browsers/chromium';
  if (fs.existsSync(doAmbiente)) return doAmbiente;
  return undefined;
}

/** Localiza o Google Chrome (ou Edge) REAL instalado na máquina. */
function localizarNavegadorReal() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const home = os.homedir();
  const candidatos = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(home, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];
  return candidatos.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

/** Proxy de saída (apenas ambientes restritos; numa máquina normal é undefined). */
function resolverProxy() {
  const server = process.env.PLAYWRIGHT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { server } : undefined;
}

/** Args extras do Chromium empacotado (TLS 1.2 sob proxy que intercepta TLS). */
function argsChromium(proxy) {
  const args = [];
  if (proxy) args.push('--ssl-version-max=tls1.2');
  if (process.env.PLAYWRIGHT_ARGS) args.push(...process.env.PLAYWRIGHT_ARGS.split(' ').filter(Boolean));
  return args;
}

// ---------------------------------------------------------------------------
// Validação de CNPJ / utilidades
// ---------------------------------------------------------------------------

export function limparCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

export function cnpjValido(cnpj) {
  const c = limparCnpj(cnpj);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;

  const calcDigito = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = calcDigito(c.slice(0, 12));
  const d2 = calcDigito(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

function sanitizarNomeArquivo(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Emite o DAS do MEI para um período (mês) específico e salva o PDF.
 *
 * @param {object} opts
 * @param {string} opts.cnpj        CNPJ (com ou sem formatação)
 * @param {number|string} opts.ano  Ano-calendário (ex: 2026)
 * @param {number|string} opts.mes  Mês de apuração 1..12
 * @param {'chrome'|'assistido'|'headless'|'headful'} [opts.modo='chrome']
 *        - 'chrome':    abre o Chrome/Edge REAL e se conecta (melhor contra o captcha). [recomendado]
 *        - 'assistido': tenta o Chromium oculto; se o captcha bloquear, cai para o Chrome real.
 *        - 'headless':  Chromium oculto (falha com CaptchaBloqueado se desafiado). Para testes/CI.
 *        - 'headful':   Chromium empacotado com janela (costuma ser bloqueado pelo hCaptcha).
 * @param {string}  [opts.outputDir]  Diretório do PDF (default: ./downloads)
 * @param {string}  [opts.perfilDir]  Diretório do perfil persistente (default: ./.perfil-chromium)
 * @param {number}  [opts.timeoutCaptcha=300000]  Tempo máx. aguardando identificação manual (ms)
 * @param {function}[opts.onLog]      Callback de log (msg) => void
 * @param {function}[opts.aoAguardarCaptcha]  Chamado quando entra em espera manual do captcha
 * @returns {Promise<{pdfPath:string, fileName:string, nome:string, valor:string|null, periodo:string}>}
 */
export async function emitirDAS(opts = {}) {
  const {
    cnpj, ano, mes,
    modo = 'chrome',
    outputDir,
    perfilDir,
    timeoutCaptcha = 300000,
    onLog,
    aoAguardarCaptcha,
  } = opts;

  const log = (msg) => {
    if (typeof onLog === 'function') onLog(msg);
    else console.log(`[pgmei] ${msg}`);
  };

  const cnpjLimpo = limparCnpj(cnpj);
  if (cnpjLimpo.length !== 14) throw new Error('CNPJ deve conter 14 dígitos (com dígito verificador).');
  const anoNum = Number(ano);
  const mesNum = Number(mes);
  if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) throw new Error('Mês inválido. Informe um número de 1 a 12.');
  if (!Number.isInteger(anoNum) || anoNum < 2009 || anoNum > 2100) throw new Error('Ano inválido.');

  const periodoPA = `${anoNum}${String(mesNum).padStart(2, '0')}`;
  const dir = outputDir || path.resolve(process.cwd(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const perfil = perfilDir || path.resolve(process.cwd(), '.perfil-chromium');
  fs.mkdirSync(perfil, { recursive: true });

  const ctx = { cnpjLimpo, anoNum, mesNum, periodoPA, dir, perfil, timeoutCaptcha, log, aoAguardarCaptcha };
  log(`Iniciando emissão do DAS — CNPJ ${cnpjLimpo}, ${MESES_PT[mesNum - 1]}/${anoNum} (PA ${periodoPA})`);

  if (modo === 'chrome') {
    const sessao = await abrirSessaoChromeReal(ctx);
    return await comSessao(sessao, (context, page) => rodarPassos(context, page, ctx, { esperarCaptcha: true }));
  }

  if (modo === 'assistido') {
    try {
      log('Tentativa 1: Chromium oculto (headless)...');
      const s1 = await abrirSessaoPlaywright(ctx, { headless: true });
      return await comSessao(s1, (context, page) => rodarPassos(context, page, ctx, { esperarCaptcha: false }));
    } catch (err) {
      if (!(err instanceof CaptchaBloqueado)) throw err;
      log('Captcha bloqueou o modo oculto. Abrindo o Chrome real para você resolver...');
      const s2 = await abrirSessaoChromeReal(ctx);
      return await comSessao(s2, (context, page) => rodarPassos(context, page, ctx, { esperarCaptcha: true }));
    }
  }

  // 'headless' | 'headful' (Chromium empacotado)
  const headless = modo !== 'headful';
  const s = await abrirSessaoPlaywright(ctx, { headless });
  return await comSessao(s, (context, page) => rodarPassos(context, page, ctx, { esperarCaptcha: !headless }));
}

/** Executa `fn` com a sessão e garante o fechamento. */
async function comSessao(sessao, fn) {
  try {
    return await fn(sessao.context, sessao.page);
  } finally {
    await sessao.fechar().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Abertura de sessão
// ---------------------------------------------------------------------------

/** Sessão com o Chromium empacotado (perfil persistente). */
async function abrirSessaoPlaywright(ctx, { headless }) {
  const proxy = resolverProxy();
  const context = await chromium.launchPersistentContext(ctx.perfil, {
    headless,
    executablePath: resolverExecutavel(),
    proxy,
    args: argsChromium(proxy),
    ignoreHTTPSErrors: Boolean(proxy),
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(45000);
  return { context, page, fechar: () => context.close() };
}

/**
 * Sessão com o Chrome/Edge REAL: abre o navegador como processo normal (sem
 * flags de automação) e conecta via CDP. É a abordagem menos detectável pelo
 * hCaptcha.
 */
async function abrirSessaoChromeReal(ctx) {
  const exe = localizarNavegadorReal();
  if (!exe) {
    throw new Error(
      'Não encontrei o Google Chrome (nem o Edge) instalado. Instale o Chrome ' +
      '(https://www.google.com/chrome/) ou defina a variável CHROME_PATH apontando para o chrome.exe.'
    );
  }
  ctx.log(`Abrindo o navegador real: ${exe}`);

  // Perfil dedicado (não mexe no seu perfil pessoal do Chrome).
  const perfilChrome = path.join(ctx.perfil, 'chrome-real');
  fs.mkdirSync(perfilChrome, { recursive: true });
  // Remove trava de sessão anterior, se houver.
  try { fs.rmSync(path.join(perfilChrome, 'DevToolsActivePort'), { force: true }); } catch {}

  const proc = spawn(exe, [
    '--remote-debugging-port=0',
    `--user-data-dir=${perfilChrome}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    URL_IDENTIFICACAO,
  ], { detached: false, stdio: 'ignore' });

  proc.on('error', (e) => ctx.log(`Falha ao iniciar o navegador: ${e.message}`));

  // Descobre a porta CDP a partir do arquivo DevToolsActivePort.
  const porta = await esperarPortaCDP(perfilChrome, 20000);
  const endpoint = `http://127.0.0.1:${porta}`;
  ctx.log('Conectando à sessão do navegador...');
  const browser = await chromium.connectOverCDP(endpoint);

  const context = browser.contexts()[0] || await browser.newContext();
  // A aba inicial já abriu a identificação; usa-a (ou cria uma).
  let page = context.pages().find((p) => p.url().includes('pgmei.app')) || context.pages()[0];
  if (!page) page = await context.newPage();
  page.setDefaultTimeout(45000);

  const fechar = async () => {
    await browser.close().catch(() => {}); // desconecta o Playwright
    try { proc.kill(); } catch {}
  };
  return { context, page, fechar };
}

/** Aguarda o Chrome escrever DevToolsActivePort e devolve a porta CDP. */
async function esperarPortaCDP(perfilChrome, timeout) {
  const arquivo = path.join(perfilChrome, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const conteudo = fs.readFileSync(arquivo, 'utf8').trim();
      const porta = Number(conteudo.split('\n')[0]);
      if (porta > 0) {
        await sondarHttp(`http://127.0.0.1:${porta}/json/version`, 3000).catch(() => {});
        return porta;
      }
    } catch { /* ainda não escreveu */ }
    await esperar(250);
  }
  throw new Error('Não foi possível iniciar a depuração do navegador (porta CDP não abriu).');
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sondarHttp(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Passos do fluxo (independentes do tipo de sessão)
// ---------------------------------------------------------------------------

async function rodarPassos(context, page, ctx, { esperarCaptcha }) {
  const { cnpjLimpo, anoNum, mesNum, periodoPA, dir, timeoutCaptcha, log, aoAguardarCaptcha } = ctx;

  // 1) Identificação
  log('Acessando página de identificação...');
  if (!page.url().includes('/Identificacao')) {
    await page.goto(URL_IDENTIFICACAO, { waitUntil: 'domcontentloaded' });
  } else {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  // 2) Preencher CNPJ e continuar
  log('Preenchendo CNPJ...');
  await page.locator('#cnpj').fill(cnpjLimpo);
  await page.getByRole('button', { name: /Continuar/i }).click();

  const desfecho = await aguardarDesfechoIdentificacao(page);
  if (desfecho.tipo === 'captcha') {
    if (!esperarCaptcha) {
      throw new CaptchaBloqueado('Portal bloqueou por captcha (comportamento de robô).');
    }
    log('⚠️  Resolva o captcha/identificação na janela do navegador (digite o CNPJ e clique em Continuar, se preciso).');
    log('    A automação continua sozinha assim que a identificação for aceita...');
    if (typeof aoAguardarCaptcha === 'function') aoAguardarCaptcha();
    await esperarIdentificacaoAceita(page, timeoutCaptcha, log);
  } else if (desfecho.tipo === 'erro') {
    throw new Error(`O portal retornou um erro após informar o CNPJ: "${desfecho.mensagem}"`);
  }

  // 3) Emitir Guia de Pagamento (DAS)
  log('Selecionando "Emitir Guia de Pagamento (DAS)"...');
  const linkEmissao = page.locator(SELETOR_MENU_EMISSAO);
  if (await linkEmissao.count()) await linkEmissao.first().click();
  else await page.goto(URL_EMISSAO, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');

  // 4) Selecionar o ano e OK
  log(`Selecionando o ano-calendário ${anoNum}...`);
  await selecionarAno(page, anoNum, log);
  log('Confirmando o ano (Ok)...');
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.getByRole('button', { name: /^Ok$/i }).click(),
  ]);
  await page.waitForLoadState('domcontentloaded');

  // 5) Marcar o mês e Apurar/Gerar DAS
  log(`Marcando o período ${MESES_PT[mesNum - 1]}/${anoNum}...`);
  const checkbox = page.locator(`input.paSelecionado[value="${periodoPA}"]`);
  if (!(await checkbox.count())) {
    throw new Error(
      `O período ${MESES_PT[mesNum - 1]}/${anoNum} (${periodoPA}) não foi encontrado na lista de apuração. ` +
      `Verifique se o mês já está disponível para emissão neste ano.`
    );
  }
  await checkbox.first().check();
  log('Clicando em "Apurar/Gerar DAS"...');
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.getByRole('button', { name: /Apurar\/Gerar DAS/i }).click(),
  ]);
  await page.waitForLoadState('domcontentloaded');

  // 6) Nome, valor e PDF
  const nome = await extrairNome(page);
  const valor = await extrairValor(page);
  log(`Contribuinte: ${nome || '(não identificado)'}${valor ? ` — Valor: ${valor}` : ''}`);

  const botaoImprimir = page.locator(`a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]`);
  if (!(await botaoImprimir.count())) {
    throw new Error('Botão "Imprimir/Visualizar PDF" não encontrado — a apuração pode não ter sido gerada.');
  }

  log('Baixando o PDF da guia...');
  const pdfBuffer = await baixarPdf(context, page, botaoImprimir, log);

  const base = sanitizarNomeArquivo(nome || `DAS ${cnpjLimpo}`);
  const fileName = `${base} - ${MESES_PT[mesNum - 1]}-${anoNum}.pdf`;
  const pdfPath = path.join(dir, fileName);
  fs.writeFileSync(pdfPath, pdfBuffer);
  log(`PDF salvo em: ${pdfPath}`);

  return {
    pdfPath,
    fileName,
    nome: nome || null,
    valor: valor || null,
    periodo: `${MESES_PT[mesNum - 1]}/${anoNum}`,
  };
}

/** Após "Continuar", determina: 'ok' | 'captcha' | 'erro'. */
async function aguardarDesfechoIdentificacao(page) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };
    const info = await page.evaluate(() => {
      const texto = (document.body.innerText || '');
      const captcha = /Comportamento de Rob[oô]|Impedido por prote[cç][aã]o Captcha|13896/i.test(texto);
      const desafio = Array.from(document.querySelectorAll('iframe[src*="hcaptcha"]'))
        .some((f) => /challenge/i.test(f.src) &&
          f.getBoundingClientRect().width > 50 && f.getBoundingClientRect().height > 50);
      const alerta = document.querySelector('.alert-danger, .validationSummary li, .field-validation-error');
      const msgErro = alerta ? (alerta.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return { captcha, desafio, msgErro };
    });
    if (info.captcha || info.desafio) return { tipo: 'captcha' };
    if (info.msgErro && !/captcha/i.test(info.msgErro)) return { tipo: 'erro', mensagem: info.msgErro };
    await page.waitForTimeout(600);
  }
  if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };
  return { tipo: 'captcha' };
}

/** Poll até a identificação ser aceita (menu de emissão aparecer). */
async function esperarIdentificacaoAceita(page, timeout, log) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator(SELETOR_MENU_EMISSAO).count().catch(() => 0)) {
      log('Identificação aceita. Retomando a automação.');
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Tempo esgotado aguardando a resolução do captcha/identificação.');
}

/** Seleciona o ano no dropdown bootstrap-select (com fallback para o <select> nativo). */
async function selecionarAno(page, anoNum, log) {
  const anoStr = String(anoNum);
  const botaoDropdown = page.locator('button[data-id="anoCalendarioSelect"]');
  if (await botaoDropdown.count()) {
    await botaoDropdown.first().click();
    const opcao = page.locator('.dropdown-menu.open li a, ul.dropdown-menu.inner li a')
      .filter({ hasText: new RegExp(`^\\s*${anoStr}\\s*$`) });
    if (await opcao.count()) { await opcao.first().click(); return; }
    log('Ano não encontrado no dropdown visual, tentando o <select> nativo...');
    await page.keyboard.press('Escape').catch(() => {});
  }
  const select = page.locator('select#anoCalendarioSelect, select[name="anoCalendarioSelect"]').first();
  if (await select.count()) {
    await select.selectOption(anoStr).catch(async () => {
      await page.evaluate((ano) => {
        const el = document.querySelector('select#anoCalendarioSelect, select[name="anoCalendarioSelect"]');
        if (el) {
          el.value = ano;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.jQuery) window.jQuery(el).trigger('change');
        }
      }, anoStr);
    });
    return;
  }
  throw new Error(`Não foi possível localizar o seletor de ano para escolher ${anoStr}.`);
}

/** Extrai o nome do contribuinte (li > strong "Nome:"). */
async function extrairNome(page) {
  const nome = await page.evaluate(() => {
    const strongs = Array.from(document.querySelectorAll('li strong, strong'));
    for (const s of strongs) {
      if (/nome\s*:/i.test(s.textContent || '')) {
        const li = s.closest('li') || s.parentElement;
        if (li) {
          const full = (li.textContent || '').replace(/nome\s*:/i, '').trim();
          if (full) return full;
        }
      }
    }
    return '';
  });
  return (nome || '').replace(/\s+/g, ' ').trim();
}

/** Extrai um valor monetário do DAS (informativo). */
async function extrairValor(page) {
  const valor = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('td, span, strong, li, b'));
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      const m = t.match(/R\$\s*[\d.]+,\d{2}/);
      if (m && /total|valor/i.test((n.closest('tr, li, p, div')?.textContent) || t)) return m[0];
    }
    const any = document.body.innerText.match(/R\$\s*[\d.]+,\d{2}/);
    return any ? any[0] : '';
  });
  return (valor || '').trim();
}

/** Obtém o binário do PDF da guia. */
async function baixarPdf(context, page, botaoImprimir, log) {
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  const [download] = await Promise.all([
    downloadPromise,
    botaoImprimir.first().click().catch(() => {}),
  ]);
  if (download) {
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    if (chunks.length) return Buffer.concat(chunks);
  }

  log('Obtendo o PDF via requisição autenticada...');
  const resp = await context.request.get(URL_IMPRIMIR);
  if (!resp.ok()) throw new Error(`Falha ao baixar o PDF (HTTP ${resp.status()}).`);
  const body = await resp.body();
  const isPdf = body.length > 4 && body.slice(0, 4).toString('latin1') === '%PDF';
  if (!isPdf) throw new Error('O conteúdo retornado não parece ser um PDF. A sessão pode ter expirado.');
  return body;
}

export { MESES_PT };
