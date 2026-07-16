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
// Modo assistido: o portal usa hCaptcha invisível que bloqueia comportamento
// de robô. A automação tenta primeiro em modo oculto (headless); se o captcha
// desafiar, ela abre a janela real do navegador para o usuário resolver e
// retoma de onde parou. Um perfil persistente guarda os cookies, reduzindo
// desafios nas execuções seguintes.
//
// Exporta: emitirDAS(opts) => { pdfPath, fileName, nome, valor, periodo }

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Descobre o executável do Chromium.
 * - Respeita PLAYWRIGHT_CHROMIUM_PATH se definido.
 * - Usa o browser pré-instalado do ambiente (/opt/pw-browsers/chromium), se existir.
 * - Caso contrário, retorna undefined para o Playwright usar seu browser padrão.
 */
function resolverExecutavel() {
  const explicito = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (explicito && fs.existsSync(explicito)) return explicito;
  const doAmbiente = '/opt/pw-browsers/chromium';
  if (fs.existsSync(doAmbiente)) return doAmbiente;
  return undefined;
}

/**
 * Configuração de proxy. Em máquinas normais não há proxy e retorna undefined.
 * Em ambientes com proxy de saída (ex.: CI/sandbox), define HTTPS_PROXY.
 */
function resolverProxy() {
  const server = process.env.PLAYWRIGHT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { server } : undefined;
}

/**
 * Argumentos extras do Chromium. Em ambientes com proxy de saída que
 * intercepta TLS (sandbox/CI), o handshake TLS 1.3 do Chromium pode ser
 * resetado pelo gateway — limitar a TLS 1.2 resolve. Numa máquina normal
 * (sem proxy) nada disso é aplicado e o TLS permanece completo.
 */
function argsChromium(proxy) {
  const args = [];
  if (proxy) args.push('--ssl-version-max=tls1.2');
  if (process.env.PLAYWRIGHT_ARGS) args.push(...process.env.PLAYWRIGHT_ARGS.split(' ').filter(Boolean));
  return args;
}

/** Remove tudo que não for dígito. */
export function limparCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

/** Valida um CNPJ (14 dígitos + dígitos verificadores). */
export function cnpjValido(cnpj) {
  const c = limparCnpj(cnpj);
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false; // todos iguais

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

/** Torna um texto seguro para uso como nome de arquivo. */
function sanitizarNomeArquivo(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[\\/:*?"<>|]/g, '')    // remove caracteres inválidos
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Emite o DAS do MEI para um período (mês) específico e salva o PDF.
 *
 * @param {object} opts
 * @param {string} opts.cnpj        CNPJ (com ou sem formatação)
 * @param {number|string} opts.ano  Ano-calendário (ex: 2026)
 * @param {number|string} opts.mes  Mês de apuração 1..12
 * @param {'assistido'|'headless'|'headful'} [opts.modo='assistido']
 *        - 'assistido': tenta oculto; se o captcha desafiar, abre a janela para o usuário resolver.
 *        - 'headless':  sempre oculto (falha com CaptchaBloqueado se desafiado).
 *        - 'headful':   sempre com janela visível.
 * @param {string}  [opts.outputDir]  Diretório do PDF (default: ./downloads)
 * @param {string}  [opts.perfilDir]  Diretório do perfil persistente (default: ./.perfil-chromium)
 * @param {number}  [opts.timeoutCaptcha=180000]  Tempo máx. de espera pela resolução manual (ms)
 * @param {function}[opts.onLog]      Callback de log (msg) => void
 * @param {function}[opts.aoAguardarCaptcha]  Chamado quando entra em espera manual do captcha
 * @returns {Promise<{pdfPath:string, fileName:string, nome:string, valor:string|null, periodo:string}>}
 */
export async function emitirDAS(opts = {}) {
  const {
    cnpj, ano, mes,
    modo = 'assistido',
    outputDir,
    perfilDir,
    timeoutCaptcha = 180000,
    onLog,
    aoAguardarCaptcha,
  } = opts;

  const log = (msg) => {
    if (typeof onLog === 'function') onLog(msg);
    else console.log(`[pgmei] ${msg}`);
  };

  const cnpjLimpo = limparCnpj(cnpj);
  if (cnpjLimpo.length !== 14) {
    throw new Error('CNPJ deve conter 14 dígitos (com dígito verificador).');
  }
  const anoNum = Number(ano);
  const mesNum = Number(mes);
  if (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    throw new Error('Mês inválido. Informe um número de 1 a 12.');
  }
  if (!Number.isInteger(anoNum) || anoNum < 2009 || anoNum > 2100) {
    throw new Error('Ano inválido.');
  }

  const periodoPA = `${anoNum}${String(mesNum).padStart(2, '0')}`;
  const dir = outputDir || path.resolve(process.cwd(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const perfil = perfilDir || path.resolve(process.cwd(), '.perfil-chromium');
  fs.mkdirSync(perfil, { recursive: true });

  const ctx = { cnpjLimpo, anoNum, mesNum, periodoPA, dir, perfil, timeoutCaptcha, log, aoAguardarCaptcha };

  log(`Iniciando emissão do DAS — CNPJ ${cnpjLimpo}, ${MESES_PT[mesNum - 1]}/${anoNum} (PA ${periodoPA})`);

  if (modo === 'assistido') {
    // 1ª tentativa oculta (rápida, aproveitando cookies do perfil).
    try {
      log('Tentativa 1: modo oculto (headless)...');
      return await executarFluxo(ctx, { headless: true, esperarCaptcha: false });
    } catch (err) {
      if (!(err instanceof CaptchaBloqueado)) throw err;
      log('Captcha desafiou. Abrindo a janela do navegador para resolução manual...');
      return await executarFluxo(ctx, { headless: false, esperarCaptcha: true });
    }
  }

  const headless = modo !== 'headful';
  return await executarFluxo(ctx, { headless, esperarCaptcha: !headless });
}

/** Executa o fluxo completo numa sessão de navegador. */
async function executarFluxo(ctx, { headless, esperarCaptcha }) {
  const { cnpjLimpo, anoNum, mesNum, periodoPA, dir, perfil, timeoutCaptcha, log, aoAguardarCaptcha } = ctx;
  const proxy = resolverProxy();

  const context = await chromium.launchPersistentContext(perfil, {
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

  try {
    // 1) Página de identificação
    log('Acessando página de identificação...');
    await page.goto(URL_IDENTIFICACAO, { waitUntil: 'domcontentloaded' });

    // 2) Preencher CNPJ e continuar
    log('Preenchendo CNPJ...');
    await page.locator('#cnpj').fill(cnpjLimpo);
    await page.getByRole('button', { name: /Continuar/i }).click();

    // Aguarda um dos desfechos: avança (menu), erro de CNPJ ou bloqueio de captcha.
    const desfecho = await aguardarDesfechoIdentificacao(page);

    if (desfecho.tipo === 'captcha') {
      if (!esperarCaptcha) {
        throw new CaptchaBloqueado('Portal bloqueou por captcha (comportamento de robô).');
      }
      log('⚠️  Resolva o captcha na janela do navegador e, se necessário, clique em "Continuar".');
      log('    A automação continuará automaticamente assim que a identificação for aceita...');
      if (typeof aoAguardarCaptcha === 'function') aoAguardarCaptcha();
      await esperarIdentificacaoAceita(page, timeoutCaptcha, log);
    } else if (desfecho.tipo === 'erro') {
      throw new Error(`O portal retornou um erro após informar o CNPJ: "${desfecho.mensagem}"`);
    }
    // desfecho.tipo === 'ok' => já está no menu

    // 3) Selecionar "Emitir Guia de Pagamento (DAS)"
    log('Selecionando "Emitir Guia de Pagamento (DAS)"...');
    const linkEmissao = page.locator(SELETOR_MENU_EMISSAO);
    if (await linkEmissao.count()) {
      await linkEmissao.first().click();
    } else {
      await page.goto(URL_EMISSAO, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForLoadState('domcontentloaded');

    // 4) Selecionar o ano-calendário e clicar em "Ok"
    log(`Selecionando o ano-calendário ${anoNum}...`);
    await selecionarAno(page, anoNum, log);

    log('Confirmando o ano (Ok)...');
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.getByRole('button', { name: /^Ok$/i }).click(),
    ]);
    await page.waitForLoadState('domcontentloaded');

    // 5) Marcar o período de apuração (mês) e clicar em "Apurar/Gerar DAS"
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

    // 6) Extrair nome e valor
    const nome = await extrairNome(page);
    const valor = await extrairValor(page);
    log(`Contribuinte: ${nome || '(não identificado)'}${valor ? ` — Valor: ${valor}` : ''}`);

    const botaoImprimir = page.locator(`a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]`);
    if (!(await botaoImprimir.count())) {
      throw new Error('Botão "Imprimir/Visualizar PDF" não encontrado — a apuração pode não ter sido gerada.');
    }

    // 7) Baixar o PDF
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
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Após clicar em "Continuar", determina o desfecho da identificação.
 * Retorna { tipo: 'ok' } | { tipo: 'captcha' } | { tipo: 'erro', mensagem }.
 */
async function aguardarDesfechoIdentificacao(page) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    // Sucesso: link do menu de emissão apareceu
    if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };

    const info = await page.evaluate(() => {
      const texto = (document.body.innerText || '');
      const captcha = /Comportamento de Rob[oô]|Impedido por prote[cç][aã]o Captcha|13896/i.test(texto);
      // Desafio visível do hCaptcha (iframe de challenge, não o invisível)
      const desafio = Array.from(document.querySelectorAll('iframe[src*="hcaptcha"]'))
        .some((f) => /challenge|frame=challenge/i.test(f.src) &&
          f.getBoundingClientRect().width > 50 && f.getBoundingClientRect().height > 50);
      const alerta = document.querySelector('.alert-danger, .validationSummary li, .field-validation-error');
      const msgErro = alerta ? (alerta.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return { captcha, desafio, msgErro };
    });

    if (info.captcha || info.desafio) return { tipo: 'captcha' };
    if (info.msgErro && !/captcha/i.test(info.msgErro)) return { tipo: 'erro', mensagem: info.msgErro };

    await page.waitForTimeout(600);
  }
  // Se nada foi detectado, tratamos como possível captcha para dar chance de resolução manual.
  if (await page.locator(SELETOR_MENU_EMISSAO).count()) return { tipo: 'ok' };
  return { tipo: 'captcha' };
}

/** Espera (poll) até a identificação ser aceita (menu de emissão aparecer). */
async function esperarIdentificacaoAceita(page, timeout, log) {
  const deadline = Date.now() + timeout;
  let avisou = false;
  while (Date.now() < deadline) {
    if (await page.locator(SELETOR_MENU_EMISSAO).count()) {
      log('Identificação aceita. Retomando a automação.');
      return;
    }
    if (!avisou && Date.now() > deadline - timeout + 15000) avisou = true;
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
    if (await opcao.count()) {
      await opcao.first().click();
      return;
    }
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

/** Extrai o nome do contribuinte do bloco de dados (li > strong "Nome:"). */
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

/** Tenta extrair o valor total do DAS exibido na tela (informativo). */
async function extrairValor(page) {
  const valor = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('td, span, strong, li, b'));
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      const m = t.match(/R\$\s*[\d.]+,\d{2}/);
      if (m && /total|valor/i.test((n.closest('tr, li, p, div')?.textContent) || t)) {
        return m[0];
      }
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

  log('Sem evento de download; obtendo o PDF via requisição autenticada...');
  const resp = await context.request.get(URL_IMPRIMIR);
  if (!resp.ok()) {
    throw new Error(`Falha ao baixar o PDF (HTTP ${resp.status()}).`);
  }
  const body = await resp.body();
  const isPdf = body.length > 4 && body.slice(0, 4).toString('latin1') === '%PDF';
  if (!isPdf) {
    throw new Error('O conteúdo retornado não parece ser um PDF. A sessão pode ter expirado.');
  }
  return body;
}

export { MESES_PT };
