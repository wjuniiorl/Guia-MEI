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
    auto = false,        // (modo chrome) preenche CNPJ e clica Continuar sozinho (experimental)
    minimizar = false,   // (modo chrome) abre a janela minimizada ("invisível", mas passa no captcha)
    chromeHeadless = false, // (modo chrome) headless de verdade — EXPERIMENTAL, costuma ser bloqueado
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

  const ctx = {
    cnpjLimpo, anoNum, mesNum, periodoPA, dir, perfil, timeoutIdentificacao, log, confirmar,
    novoPerfil, autoInicio: auto, minimizar, headless: chromeHeadless,
  };
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

  // Perfil dedicado e PERSISTENTE (não recriamos a cada execução: assim o Chrome
  // lembra que você dispensou o login e não fica perguntando de novo).
  const perfilChrome = path.join(ctx.perfil, 'chrome-real');
  if (ctx.novoPerfil) { try { fs.rmSync(perfilChrome, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(perfilChrome, { recursive: true });
  try { fs.rmSync(path.join(perfilChrome, 'DevToolsActivePort'), { force: true }); } catch {}

  const porta = Number(process.env.PGMEI_DEBUG_PORT || 9222);
  // Flags mínimas. --no-first-run e --no-default-browser-check só evitam os
  // prompts de "primeira execução" e "definir como padrão" (não mexem na
  // impressão digital). NÃO adicione --disable-features/--disable-sync: isso
  // reativa o bloqueio "Comportamento de Robô".
  const args = [
    `--remote-debugging-port=${porta}`,
    // Necessário para o Playwright conseguir conectar via CDP no Chrome 111+.
    '--remote-allow-origins=*',
    `--user-data-dir=${perfilChrome}`,
    '--lang=pt-BR',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // "Invisível" sem ser headless: joga a janela para fora da tela (o Chrome
  // ignora /min, mas respeita a posição). Continua sendo um Chrome real, então
  // passa no hCaptcha.
  if (ctx.minimizar && !ctx.headless) {
    args.push('--window-position=-32000,-32000', '--window-size=1200,900');
  }
  // EXPERIMENTAL: headless costuma ser bloqueado pelo hCaptcha (impressão
  // digital de robô). Mantido como opção para o usuário testar.
  if (ctx.headless) {
    args.push('--headless=new', '--window-size=1280,900');
  }
  args.push(URL_IDENTIFICACAO);

  log(ctx.headless
    ? 'Abrindo o navegador em modo headless (experimental)...'
    : `Abrindo o seu navegador: ${exe}`);
  // CRÍTICO: o Chrome é aberto DESTACADO do Node (como se você tivesse digitado
  // o comando no terminal). Quando o Node abre o Chrome como processo filho, o
  // hCaptcha detecta e bloqueia ("Comportamento de Robô"). Destacar resolve.
  const proc = lancarNavegadorDestacado(exe, args, log, { minimizar: ctx.minimizar && !ctx.headless });

  const fecharNavegador = async (browser, page) => {
    try {
      if (page) { const s = await page.context().newCDPSession(page); await s.send('Browser.close'); }
    } catch { /* fecha pelo processo abaixo */ }
    try { if (browser) await browser.close(); } catch {}
    try { proc.kill(); } catch {}
  };

  let browser = null;
  let page = null;
  try {
    if (ctx.autoInicio) {
      // MODO AUTOMÁTICO (experimental): a automação preenche o CNPJ e clica em
      // Continuar. Pode ser bloqueado pelo hCaptcha — se for, use o modo normal.
      const portaReal = await esperarPortaCDP(perfilChrome, porta, 25000);
      log('Conectando ao navegador (modo automático)...');
      browser = await conectarCDP(portaReal, log);
      const context = browser.contexts()[0] || await browser.newContext();
      page = await encontrarPaginaComCampo(context, '#cnpj', 30000);
      page.setDefaultTimeout(45000);

      log('Preenchendo o CNPJ e clicando em Continuar...');
      await page.locator('#cnpj').fill(cnpjLimpo);
      await page.getByRole('button', { name: /Continuar/i }).click();

      // Detecta bloqueio de captcha logo após o clique.
      await page.waitForTimeout(3500);
      const bloqueado = await page.evaluate(() =>
        /Comportamento de Rob[oô]|Impedido por prote[cç][aã]o Captcha|13896/i.test(document.body.innerText || ''));
      if (bloqueado) {
        throw new CaptchaBloqueado(
          'O modo automático (--auto) foi bloqueado pelo captcha. Rode SEM --auto ' +
          '(você digita o CNPJ e clica em Continuar manualmente).'
        );
      }

      // Se apareceu um desafio de captcha para resolver, espera o usuário.
      if (!(await page.locator(SELETOR_MENU_EMISSAO).count())) {
        log('Se aparecer um desafio de captcha, resolva na janela. Aguardando identificação...');
        await esperarIdentificacaoAceita(page, ctx.timeoutIdentificacao, log);
      }

      const resultado = await rodarEmissao(context, page, ctx);
      await fecharNavegador(browser, page);
      return resultado;
    }

    // MODO NORMAL: o usuário faz a identificação; a automação só assume na fase 2.
    log('');
    log('┌─ FAÇA A IDENTIFICAÇÃO NA JANELA DO NAVEGADOR ─────────────────────');
    log('│  • Se pedir login/definir padrão, pode dispensar (não é preciso).');
    log(`│  1) Digite o CNPJ:  ${formatarCnpj(cnpjLimpo)}`);
    log('│  2) Clique em "Continuar" e resolva o captcha, se aparecer.');
    log('│  3) Aguarde chegar na tela com "Emitir Guia de Pagamento (DAS)".');
    log('└──────────────────────────────────────────────────────────────────');

    if (typeof ctx.confirmar === 'function') {
      await ctx.confirmar(); // ex.: CLI aguarda o ENTER do usuário
    }

    // FASE 2: agora sim conecta a automação e detecta a identificação.
    const portaReal = await esperarPortaCDP(perfilChrome, porta, 25000);
    log('Conectando ao navegador para continuar a emissão...');
    browser = await conectarCDP(portaReal, log);
    const context = browser.contexts()[0] || await browser.newContext();
    page = await encontrarPaginaIdentificada(context, ctx.timeoutIdentificacao, log);
    page.setDefaultTimeout(45000);
    const resultado = await rodarEmissao(context, page, ctx);
    await fecharNavegador(browser, page);
    return resultado;
  } catch (err) {
    await fecharNavegador(browser, page);
    throw err;
  }
}

/** Encontra a aba do PGMEI que contém um campo (ex.: #cnpj). Aguarda se preciso. */
async function encontrarPaginaComCampo(context, seletor, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (!p.url().includes('pgmei.app')) continue;
      if (await p.locator(seletor).count().catch(() => 0)) return p;
    }
    await esperar(500);
  }
  throw new Error('Não encontrei o campo de CNPJ na janela do navegador.');
}

/**
 * Abre o navegador DESTACADO do processo Node (para não ficar como processo
 * filho — o que o hCaptcha detecta). No Windows usa `cmd /c start`, replicando
 * um lançamento manual pelo usuário.
 */
function lancarNavegadorDestacado(exe, args, log, { minimizar = false } = {}) {
  let proc;
  if (process.platform === 'win32') {
    // /min abre a janela minimizada (fica "invisível" sem ser headless).
    const min = minimizar ? '/min ' : '';
    const linha = `start "PGMEI" ${min}"${exe}" ` + args.map((a) => `"${a}"`).join(' ');
    proc = spawn('cmd.exe', ['/c', linha], { stdio: 'ignore', windowsVerbatimArguments: true });
  } else {
    proc = spawn(exe, args, { stdio: 'ignore', detached: true });
    proc.unref();
  }
  proc.on('error', (e) => log(`Falha ao iniciar o navegador: ${e.message}`));
  return proc;
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

/**
 * Aguarda a depuração do Chrome ficar pronta e devolve a porta REAL (lida do
 * arquivo DevToolsActivePort, que é a fonte da verdade — caso a porta pedida
 * estivesse ocupada, o Chrome pode ter usado outra).
 */
async function esperarPortaCDP(perfilChrome, portaPedida, timeout) {
  const arquivo = path.join(perfilChrome, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let porta = portaPedida;
    try {
      const doArquivo = Number(fs.readFileSync(arquivo, 'utf8').trim().split('\n')[0]);
      if (doArquivo > 0) porta = doArquivo;
    } catch { /* ainda não escreveu */ }

    for (const host of ['127.0.0.1', 'localhost']) {
      const ok = await sondarHttp(`http://${host}:${porta}/json/version`, 2000)
        .then(() => true).catch(() => false);
      if (ok) return porta;
    }
    await esperar(300);
  }
  throw new Error('Não foi possível conectar à depuração do navegador (a janela do Chrome abriu?).');
}

/** Conecta ao Chrome via CDP, tentando 127.0.0.1 e localhost, com pequena repetição. */
async function conectarCDP(porta, log) {
  const endpoints = [`http://127.0.0.1:${porta}`, `http://localhost:${porta}`];
  let ultimoErro;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    for (const ep of endpoints) {
      try {
        return await chromium.connectOverCDP(ep);
      } catch (e) { ultimoErro = e; }
    }
    await esperar(500);
  }
  throw new Error(`Não consegui conectar ao navegador via CDP: ${ultimoErro?.message || 'desconhecido'}`);
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

  // NOTA: NÃO usamos waitForLoadState('networkidle') — páginas do gov.br mantêm
  // conexões abertas e a rede "nunca para", o que travava a automação. Em vez
  // disso, esperamos os ELEMENTOS certos aparecerem em cada etapa.

  // Emitir Guia de Pagamento (DAS)
  log('Selecionando "Emitir Guia de Pagamento (DAS)"...');
  const linkEmissao = page.locator(SELETOR_MENU_EMISSAO);
  if (await linkEmissao.count()) await linkEmissao.first().click();
  else await page.goto(URL_EMISSAO, { waitUntil: 'domcontentloaded' });

  // Espera o seletor de ano aparecer.
  await page
    .locator('button[data-id="anoCalendarioSelect"], select#anoCalendarioSelect, select[name="anoCalendarioSelect"]')
    .first().waitFor({ state: 'visible', timeout: 30000 });

  // Selecionar o ano e OK
  log(`Selecionando o ano-calendário ${anoNum}...`);
  await selecionarAno(page, anoNum, log);
  log('Confirmando o ano (Ok)...');
  await page.getByRole('button', { name: /^Ok$/i }).click();

  // Espera a tabela de períodos carregar (o checkbox do mês aparecer).
  log('Aguardando os períodos de apuração carregarem...');
  const checkbox = page.locator(`input.paSelecionado[value="${periodoPA}"]`);
  try {
    await checkbox.first().waitFor({ state: 'attached', timeout: 30000 });
  } catch {
    throw new Error(
      `O período ${MESES_PT[mesNum - 1]}/${anoNum} (${periodoPA}) não apareceu na lista de apuração. ` +
      `Verifique se o mês já está disponível para emissão neste ano.`
    );
  }

  // Marcar o mês (o input pode estar coberto por um label — usa check e, se
  // falhar, clica via JS).
  log(`Marcando o período ${MESES_PT[mesNum - 1]}/${anoNum}...`);
  try {
    await checkbox.first().check({ timeout: 10000 });
  } catch {
    await checkbox.first().evaluate((el) => {
      el.checked = true;
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Captura o valor Total da linha do período (coluna "Total"), enquanto a
  // tabela ainda está visível. É o valor correto a pagar do DAS.
  const valor = await extrairValorPeriodo(page, periodoPA);

  // Apurar/Gerar DAS
  log('Clicando em "Apurar/Gerar DAS"...');
  await page.getByRole('button', { name: /Apurar\/Gerar DAS/i }).click();

  // Espera o botão "Imprimir/Visualizar PDF" aparecer (tela de resultado).
  log('Aguardando a geração do DAS...');
  const botaoImprimir = page.locator(`a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]`);
  try {
    await botaoImprimir.first().waitFor({ state: 'attached', timeout: 45000 });
  } catch {
    // Talvez tenha aparecido um aviso/erro na tela.
    const aviso = await page.evaluate(() => {
      const a = document.querySelector('.alert, .alert-danger, .validationSummary');
      return a ? (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    });
    throw new Error(
      'Botão "Imprimir/Visualizar PDF" não apareceu — a apuração pode não ter sido gerada.' +
      (aviso ? ` Mensagem da tela: "${aviso}"` : '')
    );
  }

  // Nome do contribuinte
  const nome = await extrairNome(page);
  log(`Contribuinte: ${nome || '(não identificado)'}${valor ? ` — Valor: ${valor}` : ''}`);

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

/**
 * Extrai o valor Total do período na tabela de apuração. A linha do mês tem as
 * colunas Principal, Multa, Juros e Total — pegamos o Total (4º valor R$).
 */
async function extrairValorPeriodo(page, periodoPA) {
  const valor = await page.evaluate((pa) => {
    const inp = document.querySelector(`input.paSelecionado[value="${pa}"]`);
    const tr = inp ? inp.closest('tr') : null;
    if (!tr) return '';
    const vals = (tr.innerText.match(/R\$\s*[\d.]+,\d{2}/g) || []).map((v) => v.replace(/\s+/g, ' '));
    if (vals.length >= 4) return vals[3];               // coluna Total
    return vals.length ? vals[vals.length - 1] : '';    // fallback: último valor
  }, periodoPA);
  return (valor || '').trim();
}

async function baixarPdf(context, page, botaoImprimir, log) {
  // Caminho principal: o link "Imprimir" é um GET direto que devolve o PDF.
  // Buscamos pela sessão do navegador (mesmos cookies) — sem abrir aba de PDF.
  try {
    const resp = await context.request.get(URL_IMPRIMIR);
    if (resp.ok()) {
      const body = await resp.body();
      if (body.length > 4 && body.slice(0, 4).toString('latin1') === '%PDF') return body;
    }
  } catch { /* tenta o caminho por clique abaixo */ }

  // Alternativa: clicar no botão e capturar um evento de download.
  log('Tentando baixar via clique no botão...');
  const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
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

  // Última tentativa: nova aba com o PDF aberto.
  for (const p of context.pages()) {
    if (p.url().includes('/emissao/imprimir')) {
      const r = await context.request.get(p.url());
      if (r.ok()) {
        const b = await r.body();
        if (b.slice(0, 4).toString('latin1') === '%PDF') return b;
      }
    }
  }
  throw new Error('Não consegui obter o PDF da guia. A apuração foi gerada?');
}

export { MESES_PT };
