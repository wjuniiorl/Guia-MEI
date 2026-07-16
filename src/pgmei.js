// Núcleo da automação de emissão do DAS (PGMEI) usando Playwright.
//
// CAPTCHA (importante): a tela de identificação do PGMEI usa hCaptcha INVISÍVEL
// que roda no clique do botão "Continuar" e DETECTA/BLOQUEIA navegadores
// controlados por automação (Playwright/Selenium) — muitas vezes sem exibir
// desafio, apenas recusando ("Comportamento de Robô"). Até uma conexão de
// depuração (CDP) durante a identificação pode ser detectada.
//
// Por isso o modo recomendado é 'chrome', que separa as duas fases:
//   FASE 1 (identificação, com captcha): a ferramenta apenas ABRE o seu Chrome
//     real (sem qualquer automação conectada). VOCÊ digita o CNPJ, clica em
//     Continuar e resolve o captcha, como um humano normal. Nada de automação
//     encostando no navegador aqui — então o hCaptcha vê um navegador legítimo.
//   FASE 2 (emissão, sem captcha): quando você já está identificado, a
//     automação SE CONECTA ao navegador e faz o resto sozinha (ano, mês,
//     gerar e baixar o PDF). Essas telas não têm captcha.
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

function resolverExecutavel() {
  const explicito = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicito && fs.existsSync(explicito)) return explicito;
  const doAmbiente = '/opt/pw-browsers/chromium';
  if (fs.existsSync(doAmbiente)) return doAmbiente;
  return undefined;
}

/** Localiza o Google Chrome (ou Edge) REAL instalado na máquina. */
function localizarNavegadorReal() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
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
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
      ];
  return candidatos.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

/**
 * Prepara o perfil dedicado para não exibir os prompts de primeira execução
 * ("Faça login no Chrome", boas-vindas, definir navegador padrão). Escreve um
 * Preferences mínimo apenas na 1ª vez (não sobrescreve um perfil já em uso).
 */
function prepararPerfil(perfilChrome) {
  try {
    const prefsPath = path.join(perfilChrome, 'Default', 'Preferences');
    if (fs.existsSync(prefsPath)) return; // já configurado — não mexe
    const prefs = {
      profile: { exit_type: 'Normal', exited_cleanly: true, default_content_setting_values: {} },
      browser: { has_seen_welcome_page: true, check_default_browser: false },
      signin: { allowed: false, allowed_on_next_startup: false },
      sync: { requested: false },
      credentials_enable_service: false,
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    // Sentinela de "primeira execução já feita".
    fs.writeFileSync(path.join(perfilChrome, 'First Run'), '');
  } catch { /* não é crítico */ }
}

function resolverProxy() {
  const server = process.env.PLAYWRIGHT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { server } : undefined;
}

function argsChromium(proxy) {
  const args = [];
  if (proxy) args.push('--ssl-version-max=tls1.2');
  if (process.env.PLAYWRIGHT_ARGS) args.push(...process.env.PLAYWRIGHT_ARGS.split(' ').filter(Boolean));
  return args;
}

// ---------------------------------------------------------------------------
// CNPJ / utilidades
// ---------------------------------------------------------------------------

export function limparCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

export function formatarCnpj(cnpj) {
  const c = limparCnpj(cnpj).padStart(14, '0').slice(0, 14);
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12, 14)}`;
}

export function cnpjValido(cnpj) {
  const c = limparCnpj(cnpj);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;
  const calcDigito = (base) => {
    let soma = 0, peso = base.length - 7;
    for (let i = 0; i < base.length; i++) { soma += Number(base[i]) * peso; peso = peso === 2 ? 9 : peso - 1; }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = calcDigito(c.slice(0, 12));
  const d2 = calcDigito(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

function sanitizarNomeArquivo(texto) {
  return String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
 * @param {'chrome'|'headless'|'headful'} [opts.modo='chrome']
 * @param {string}  [opts.outputDir]  Diretório do PDF (default: ./downloads)
 * @param {string}  [opts.perfilDir]  Diretório do perfil dedicado (default: ./.perfil-chromium)
 * @param {number}  [opts.timeoutIdentificacao=600000]  Tempo máx. aguardando identificação (ms)
 * @param {function}[opts.onLog]     Callback de log (msg) => void
 * @param {function}[opts.confirmar] (modo chrome) async () => void — resolve quando o usuário
 *        avisar que concluiu a identificação. Se ausente, a automação aguarda automaticamente
 *        (conectando-se e detectando a tela de emissão).
 * @returns {Promise<{pdfPath, fileName, nome, valor, periodo}>}
 */
export async function emitirDAS(opts = {}) {
  const {
    cnpj, ano, mes, modo = 'chrome',
    outputDir, perfilDir,
    timeoutIdentificacao = 600000,
    onLog, confirmar,
    novoPerfil = false,  // (modo chrome) recomeça o perfil dedicado do zero
  } = opts;

  const log = (msg) => {
    if (typeof onLog === 'function') onLog(msg);
    else console.log(`[pgmei] ${msg}`);
  };

  const cnpjLimpo = limparCnpj(cnpj);
  if (cnpjLimpo.length !== 14) throw new Error('CNPJ deve conter 14 dígitos (com dígito verificador).');
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) throw new Error('Mês inválido. Informe um número de 1 a 12.');
  if (!Number.isInteger(anoNum) || anoNum < 2009 || anoNum > 2100) throw new Error('Ano inválido.');

  const periodoPA = `${anoNum}${String(mesNum).padStart(2, '0')}`;
  const dir = outputDir || path.resolve(process.cwd(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const perfil = perfilDir || path.resolve(process.cwd(), '.perfil-chromium');
  fs.mkdirSync(perfil, { recursive: true });

  const ctx = { cnpjLimpo, anoNum, mesNum, periodoPA, dir, perfil, timeoutIdentificacao, log, confirmar, novoPerfil };
  log(`Iniciando emissão do DAS — CNPJ ${formatarCnpj(cnpjLimpo)}, ${MESES_PT[mesNum - 1]}/${anoNum} (PA ${periodoPA})`);

  if (modo === 'chrome') return await emitirViaChromeReal(ctx);

  // Modos com o Chromium empacotado (headless para testes/CI; headful raramente passa no captcha).
  const headless = modo !== 'headful';
  const s = await abrirSessaoPlaywright(ctx, { headless });
  try {
    await identificarAutomatico(s.page, ctx, { esperarCaptcha: !headless });
    return await rodarEmissao(s.context, s.page, ctx);
  } finally {
    await s.fechar().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Modo 'chrome': navegador real, identificação manual, conexão só na FASE 2
// ---------------------------------------------------------------------------

async function emitirViaChromeReal(ctx) {
  const { cnpjLimpo, log } = ctx;
  const exe = localizarNavegadorReal();
  if (!exe) {
    throw new Error(
      'Não encontrei o Google Chrome (nem o Edge) instalado. Instale o Chrome ' +
      '(https://www.google.com/chrome/) ou defina a variável CHROME_PATH apontando para o chrome.exe.'
    );
  }

  // Perfil dedicado e PERSISTENTE (um perfil novo/limpo passa no hCaptcha; não
  // copiamos o perfil real — isso deixava o navegador com "cara de robô").
  const perfilChrome = path.join(ctx.perfil, 'chrome-real');
  if (ctx.novoPerfil) { try { fs.rmSync(perfilChrome, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(path.join(perfilChrome, 'Default'), { recursive: true });
  try { fs.rmSync(path.join(perfilChrome, 'DevToolsActivePort'), { force: true }); } catch {}
  prepararPerfil(perfilChrome); // suprime "faça login no Chrome" / boas-vindas

  log(`Abrindo o seu navegador: ${exe}`);
  // O navegador abre como processo normal. A porta de depuração fica disponível,
  // mas NINGUÉM se conecta durante a identificação — então não há rastro de
  // automação para o hCaptcha detectar.
  const proc = spawn(exe, [
    '--remote-debugging-port=0',
    `--user-data-dir=${perfilChrome}`,
    '--lang=pt-BR',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=SigninPromo,ChromeWhatsNewUI,PrivacySandboxSettings4',
    '--start-maximized',
    URL_IDENTIFICACAO,
  ], { detached: false, stdio: 'ignore' });
  proc.on('error', (e) => log(`Falha ao iniciar o navegador: ${e.message}`));

  try {
    // Instruções para a FASE 1 (manual).
    log('');
    log('┌─ FAÇA A IDENTIFICAÇÃO NA JANELA DO NAVEGADOR ─────────────────────');
    log(`│  1) Digite o CNPJ:  ${formatarCnpj(cnpjLimpo)}`);
    log('│  2) Clique em "Continuar" e resolva o captcha, se aparecer.');
    log('│  3) Aguarde chegar na tela com "Emitir Guia de Pagamento (DAS)".');
    log('└──────────────────────────────────────────────────────────────────');

    if (typeof ctx.confirmar === 'function') {
      await ctx.confirmar(); // ex.: CLI aguarda o ENTER do usuário
    }

    // FASE 2: agora sim conecta a automação e detecta a identificação.
    const porta = await esperarPortaCDP(perfilChrome, 20000);
    log('Conectando ao navegador para continuar a emissão...');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${porta}`);
    try {
      const context = browser.contexts()[0] || await browser.newContext();
      const page = await encontrarPaginaIdentificada(context, ctx.timeoutIdentificacao, log);
      page.setDefaultTimeout(45000);
      return await rodarEmissao(context, page, ctx);
    } finally {
      await browser.close().catch(() => {}); // apenas desconecta o Playwright
    }
  } finally {
    try { proc.kill(); } catch {}
  }
}

/** Encontra a aba já identificada (com o menu de emissão). Aguarda se preciso. */
async function encontrarPaginaIdentificada(context, timeout, log) {
  const deadline = Date.now() + timeout;
  let avisou = false;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (!p.url().includes('pgmei.app')) continue;
      if (await p.locator(SELETOR_MENU_EMISSAO).count().catch(() => 0)) return p;
    }
    if (!avisou) {
      log('Aguardando a identificação ser concluída na janela do navegador...');
      avisou = true;
    }
    await esperar(1500);
  }
  throw new Error('Tempo esgotado aguardando a identificação (tela "Emitir Guia de Pagamento (DAS)").');
}

/** Aguarda o Chrome escrever DevToolsActivePort e devolve a porta CDP. */
async function esperarPortaCDP(perfilChrome, timeout) {
  const arquivo = path.join(perfilChrome, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const porta = Number(fs.readFileSync(arquivo, 'utf8').trim().split('\n')[0]);
      if (porta > 0) {
        await sondarHttp(`http://127.0.0.1:${porta}/json/version`, 3000).catch(() => {});
        return porta;
      }
    } catch { /* ainda não escreveu */ }
    await esperar(250);
  }
  throw new Error('Não foi possível iniciar a depuração do navegador (porta CDP não abriu).');
}

function sondarHttp(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Sessão com o Chromium empacotado (modos headless/headful)
// ---------------------------------------------------------------------------

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

/** FASE 1 automática (só para modos headless/headful — sujeita a bloqueio de captcha). */
async function identificarAutomatico(page, ctx, { esperarCaptcha }) {
  const { cnpjLimpo, log } = ctx;
  log('Acessando página de identificação...');
  await page.goto(URL_IDENTIFICACAO, { waitUntil: 'domcontentloaded' });
  log('Preenchendo CNPJ...');
  await page.locator('#cnpj').fill(cnpjLimpo);
  await page.getByRole('button', { name: /Continuar/i }).click();

  const desfecho = await aguardarDesfechoIdentificacao(page);
  if (desfecho.tipo === 'captcha') {
    if (!esperarCaptcha) throw new CaptchaBloqueado('Portal bloqueou por captcha (comportamento de robô).');
    log('⚠️  Resolva o captcha/identificação na janela do navegador...');
    await esperarIdentificacaoAceita(page, ctx.timeoutIdentificacao, log);
  } else if (desfecho.tipo === 'erro') {
    throw new Error(`O portal retornou um erro após informar o CNPJ: "${desfecho.mensagem}"`);
  }
}

// ---------------------------------------------------------------------------
// FASE 2: emissão (sem captcha) — comum a todos os modos
// ---------------------------------------------------------------------------

async function rodarEmissao(context, page, ctx) {
  const { anoNum, mesNum, periodoPA, dir, cnpjLimpo, log } = ctx;

  // Emitir Guia de Pagamento (DAS)
  log('Selecionando "Emitir Guia de Pagamento (DAS)"...');
  const linkEmissao = page.locator(SELETOR_MENU_EMISSAO);
  if (await linkEmissao.count()) await linkEmissao.first().click();
  else await page.goto(URL_EMISSAO, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');

  // Selecionar o ano e OK
  log(`Selecionando o ano-calendário ${anoNum}...`);
  await selecionarAno(page, anoNum, log);
  log('Confirmando o ano (Ok)...');
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.getByRole('button', { name: /^Ok$/i }).click(),
  ]);
  await page.waitForLoadState('domcontentloaded');

  // Marcar o mês e Apurar/Gerar DAS
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

  // Nome, valor e PDF
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
    pdfPath, fileName,
    nome: nome || null,
    valor: valor || null,
    periodo: `${MESES_PT[mesNum - 1]}/${anoNum}`,
  };
}

// ---------------------------------------------------------------------------
// Detecção / helpers de página
// ---------------------------------------------------------------------------

async function aguardarDesfechoIdentificacao(page) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };
    const info = await page.evaluate(() => {
      const texto = (document.body.innerText || '');
      const captcha = /Comportamento de Rob[oô]|Impedido por prote[cç][aã]o Captcha|13896/i.test(texto);
      const alerta = document.querySelector('.alert-danger, .validationSummary li, .field-validation-error');
      const msgErro = alerta ? (alerta.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return { captcha, msgErro };
    });
    if (info.captcha) return { tipo: 'captcha' };
    if (info.msgErro && !/captcha/i.test(info.msgErro)) return { tipo: 'erro', mensagem: info.msgErro };
    await page.waitForTimeout(600);
  }
  if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };
  return { tipo: 'captcha' };
}

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
