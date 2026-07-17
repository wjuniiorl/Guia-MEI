// Motor de emissão de NFS-e no Emissor Nacional (nfse.gov.br) com login e senha.
//
// Fluxo (uma nota por vez):
//   1. Login (CPF/CNPJ + senha). Normalmente sem captcha; se aparecer, a janela
//      do Chrome fica visível para o usuário resolver e a automação continua.
//   2. Emissão completa (DPS/Pessoas): data de competência, regime SN, tomador.
//   3. Serviço: município de prestação, código LC116, descrição.
//   4. Valores: valor do serviço, tributação (Simples), alíquota SN.
//   5. Emitir NFS-e.
//
// Reaproveita os helpers de navegador do motor do DAS (mesma técnica anti-bot:
// Chrome real destacado + conexão via CDP).
//
// ATENÇÃO: este módulo é a 1ª versão do fluxo — os campos "chosen"/"select2" e a
// captura do PDF final precisam ser validados/ajustados nos testes reais.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  limparCnpj, formatarCnpj,
  localizarNavegadorReal, lancarNavegadorDestacado, esperarPortaCDP, conectarCDP, esperarMs,
} from './pgmei.js';

const BASE = 'https://www.nfse.gov.br/EmissorNacional';
const URL_LOGIN = `${BASE}/Login`;
const URL_EMISSAO_COMPLETA = `${BASE}/DPS/Pessoas`;

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Emite uma NFS-e.
 *
 * @param {object} opts
 * @param {string} opts.login        CPF/CNPJ de acesso (com ou sem máscara)
 * @param {string} opts.senha        Senha de acesso
 * @param {string} opts.municipio    Município de prestação (nome ou código IBGE)
 * @param {string} opts.tomador      CPF/CNPJ do tomador
 * @param {string} opts.valor        Valor do serviço (ex.: "1500,00" ou "1500.00")
 * @param {string} [opts.dataCompetencia]  dd/mm/aaaa (default: hoje)
 * @param {string} opts.codigoServico Código de tributação nacional (LC 116)
 * @param {string} opts.aliquota     Alíquota do Simples Nacional (ex.: "6,00")
 * @param {string} opts.descricao    Descrição do serviço
 * @param {number|string} [opts.regimeSN=1] Regime de apuração (1, 2 ou 3)
 * @param {boolean} [opts.minimizar]  Janela fora da tela
 * @param {boolean} [opts.novoPerfil] Recomeça o perfil dedicado
 * @param {boolean} [opts.pararAposLogin] Para após o login (para testes)
 * @param {string}  [opts.outputDir]  Pasta para salvar o PDF (default: ./downloads/nfse)
 * @param {string}  [opts.perfilDir]  Perfil dedicado (default: ./.perfil-nfse)
 * @param {function}[opts.onLog]
 * @returns {Promise<{ok:boolean, numero?:string, pdfPath?:string, mensagem?:string}>}
 */
export async function emitirNFSe(opts = {}) {
  const log = (m) => (typeof opts.onLog === 'function' ? opts.onLog(m) : console.log(`[nfse] ${m}`));
  const loginLimpo = limparCnpj(opts.login);
  if (!loginLimpo) throw new Error('Login (CPF/CNPJ) é obrigatório.');
  if (!opts.senha) throw new Error('Senha é obrigatória.');

  const dir = opts.outputDir || path.resolve(process.cwd(), 'downloads', 'nfse');
  fs.mkdirSync(dir, { recursive: true });
  const perfil = opts.perfilDir || path.resolve(process.cwd(), '.perfil-nfse');

  const ctx = { ...opts, loginLimpo, dir, perfil, log };
  log(`Iniciando emissão de NFS-e — login ${formatarCnpj(loginLimpo)}`);

  const sessao = await abrirNavegador(ctx);
  try {
    await login(sessao.page, ctx);
    if (opts.pararAposLogin) {
      log('Login concluído (parando aqui — modo teste).');
      return { ok: true, mensagem: 'Login OK (teste).' };
    }
    await paginaTomador(sessao.page, ctx);
    await paginaServico(sessao.page, ctx);
    await paginaValores(sessao.page, ctx);
    const resultado = await emitir(sessao.page, ctx);
    await sessao.fechar();
    return resultado;
  } catch (err) {
    await sessao.fechar();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Navegador (Chrome real destacado + CDP) — mesma técnica do DAS
// ---------------------------------------------------------------------------

async function abrirNavegador(ctx) {
  const { log } = ctx;
  const exe = localizarNavegadorReal();
  if (!exe) {
    throw new Error('Google Chrome (ou Edge) não encontrado. Instale o Chrome ou defina CHROME_PATH.');
  }
  const perfilChrome = path.join(ctx.perfil, 'chrome-real');
  if (ctx.novoPerfil) { try { fs.rmSync(perfilChrome, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(perfilChrome, { recursive: true });
  try { fs.rmSync(path.join(perfilChrome, 'DevToolsActivePort'), { force: true }); } catch {}

  const porta = Number(process.env.PGMEI_DEBUG_PORT || 9223);
  const args = [
    `--remote-debugging-port=${porta}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${perfilChrome}`,
    '--lang=pt-BR',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (ctx.minimizar) {
    args.push('--window-position=-32000,-32000', '--window-size=1200,900',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling');
  }
  args.push(URL_LOGIN);

  log(`Abrindo o navegador: ${exe}`);
  const proc = lancarNavegadorDestacado(exe, args, log, { minimizar: Boolean(ctx.minimizar) });

  const portaReal = await esperarPortaCDP(perfilChrome, porta, 25000);
  log('Conectando ao navegador...');
  const browser = await conectarCDP(portaReal, log);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages().find((p) => p.url().includes('nfse.gov.br')) || context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(45000);

  const fechar = async () => {
    try { const s = await page.context().newCDPSession(page); await s.send('Browser.close'); } catch {}
    try { await browser.close(); } catch {}
    try { proc.kill(); } catch {}
  };
  return { browser, context, page, fechar };
}

// ---------------------------------------------------------------------------
// Passos do fluxo
// ---------------------------------------------------------------------------

async function login(page, ctx) {
  const { loginLimpo, senha, log } = ctx;
  log('Acessando a tela de login...');
  if (!page.url().includes('/Login')) await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });

  log('Preenchendo login e senha...');
  await page.locator('#Inscricao').fill(loginLimpo);
  await page.locator('#Senha').fill(String(senha));
  await page.getByRole('button', { name: /Entrar/i }).click();

  // Aguarda: sucesso (saiu do /Login) ou captcha/erro.
  const prazo = Date.now() + 30000;
  while (Date.now() < prazo) {
    if (!page.url().includes('/Login')) { log('Login efetuado.'); return; }
    const estado = await page.evaluate(() => {
      const txt = document.body.innerText || '';
      const captcha = !!document.querySelector('.h-captcha, iframe[src*="hcaptcha"], .g-recaptcha, iframe[src*="recaptcha"], img[src*="aptcha"]')
        || /captcha/i.test(txt);
      const erro = document.querySelector('.validation-summary-errors, .text-danger:not(.field-validation-valid), .alert-danger');
      const msgErro = erro ? (erro.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return { captcha, msgErro };
    }).catch(() => ({ captcha: false, msgErro: '' }));

    if (estado.captcha) {
      log('⚠️  Apareceu um captcha no login. Resolva na janela do navegador — a automação continua depois.');
      // Espera o usuário resolver e o login concluir.
      const prazoCaptcha = Date.now() + (ctx.timeoutCaptcha || 300000);
      while (Date.now() < prazoCaptcha) {
        if (!page.url().includes('/Login')) { log('Login efetuado após o captcha.'); return; }
        await esperarMs(1000);
      }
      throw new Error('Tempo esgotado aguardando a resolução do captcha no login.');
    }
    if (estado.msgErro && !/captcha/i.test(estado.msgErro)) {
      throw new Error(`Falha no login: "${estado.msgErro}" (verifique login e senha).`);
    }
    await esperarMs(500);
  }
  if (page.url().includes('/Login')) throw new Error('Não foi possível efetuar o login (tempo esgotado).');
}

async function paginaTomador(page, ctx) {
  const { log } = ctx;
  log('Abrindo "Emissão completa"...');
  await page.goto(URL_EMISSAO_COMPLETA, { waitUntil: 'domcontentloaded' });
  await page.locator('#DataCompetencia').waitFor({ state: 'visible', timeout: 30000 });

  // Data de competência (default: hoje).
  const data = ctx.dataCompetencia || dataHoje();
  log(`Data de competência: ${data}`);
  await preencherData(page, '#DataCompetencia', data);

  // Regime de apuração dos tributos no Simples Nacional (chosen).
  const regime = String(ctx.regimeSN || 1);
  log(`Regime de apuração SN: ${regime}`);
  await selecionarChosen(page, 'SimplesNacional_RegimeApuracaoTributosSN', regime);

  // Tomador: garantir que o painel Brasil está ativo e preencher o CPF/CNPJ.
  await garantirTomadorBrasil(page);
  const tomador = limparCnpj(ctx.tomador);
  log(`Tomador: ${formatarCnpj(tomador)}`);
  await page.locator('#Tomador_Inscricao').fill(tomador);
  // Pesquisa para preencher o nome automaticamente.
  const btnPesquisar = page.locator('#btn_Tomador_Inscricao_pesquisar');
  if (await btnPesquisar.count()) {
    await btnPesquisar.click().catch(() => {});
    await esperarPreenchido(page, '#Tomador_Nome', 8000);
  }

  log('Avançando (tomador)...');
  await page.locator('#btnAvancar').click();
  await page.waitForLoadState('domcontentloaded');
}

async function paginaServico(page, ctx) {
  const { log } = ctx;
  // Município de prestação (select2 com busca).
  if (ctx.municipio) {
    log(`Município de prestação: ${ctx.municipio}`);
    await selecionarSelect2(page, 'LocalPrestacao_CodigoMunicipioPrestacao', ctx.municipio, log);
  }
  // Código de tributação nacional (LC 116) (select2 com busca).
  if (ctx.codigoServico) {
    log(`Código do serviço (LC 116): ${ctx.codigoServico}`);
    await selecionarSelect2(page, 'ServicoPrestado_CodigoTributacaoNacional', ctx.codigoServico, log);
  }
  // Não há exportação/imunidade/não incidência => "Não" (value 0).
  await marcarRadio(page, '#ServicoPrestado_HaExportacaoImunidadeNaoIncidencia', '0');
  // Descrição do serviço.
  if (ctx.descricao) {
    await page.locator('#ServicoPrestado_Descricao').fill(String(ctx.descricao));
  }
  log('Avançando (serviço)...');
  await clicarAvancar(page);
  await page.waitForLoadState('domcontentloaded');
}

async function paginaValores(page, ctx) {
  const { log } = ctx;
  await page.locator('#Valores_ValorServico').waitFor({ state: 'visible', timeout: 30000 });
  log(`Valor do serviço: ${ctx.valor}`);
  await page.locator('#Valores_ValorServico').fill(formatarValor(ctx.valor));

  // ISSQN retido pelo tomador: Não (pode estar desabilitado — ignora se for o caso).
  await marcarRadio(page, '#ISSQN_HaRetencao', '0').catch(() => {});

  // Tributação federal PIS/Cofins: 00 - Nenhum (Simples) (chosen).
  await selecionarChosen(page, 'TributacaoFederal_PISCofins_SituacaoTributaria', '0');
  // Tipo de retenção PIS/COFINS/CSLL: Não Retidos (value 0) (chosen).
  await selecionarChosen(page, 'TributacaoFederal_PISCofins_TipoRetencao', '0');

  // Valor aproximado dos tributos: informar alíquota do Simples Nacional (value 4).
  await marcarRadio(page, '#ValorTributos_TipoValorTributos', '4');
  await page.locator('#ValorTributos_AliquotaSN').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (ctx.aliquota) {
    await page.locator('#ValorTributos_AliquotaSN').fill(String(ctx.aliquota).replace('.', ','));
  }

  log('Avançando (valores)...');
  await clicarAvancar(page);
  await page.waitForLoadState('domcontentloaded');
}

async function emitir(page, ctx) {
  const { log } = ctx;
  log('Clicando em "Emitir NFS-e"...');
  const botao = page.locator('#btnProsseguir, a:has-text("Emitir NFS-e")').first();
  await botao.waitFor({ state: 'visible', timeout: 30000 });
  await botao.click();
  await page.waitForLoadState('domcontentloaded');

  // TODO (validar no teste real): capturar o número da NFS-e e baixar o PDF/DANFSe.
  const numero = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/NFS-?e\s*n[ºo°]?\s*[:]?\s*([\d.]+)/i);
    return m ? m[1] : '';
  }).catch(() => '');

  log(`NFS-e emitida${numero ? ` (nº ${numero})` : ''}.`);
  return { ok: true, numero: numero || null, mensagem: 'NFS-e emitida. (Download do PDF a validar.)' };
}

// ---------------------------------------------------------------------------
// Helpers de formulário
// ---------------------------------------------------------------------------

/** Seleciona um valor num dropdown "chosen" (jQuery Chosen). */
async function selecionarChosen(page, selectId, value) {
  await page.evaluate(({ id, val }) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) {
      window.jQuery(sel).val(val).trigger('chosen:updated').trigger('change');
    }
  }, { id: selectId, val: String(value) });
  await page.waitForTimeout(200);
}

/** Seleciona um item num dropdown "select2" com busca AJAX. */
async function selecionarSelect2(page, selectId, texto, log) {
  // Abre o select2 associado ao <select id=selectId>.
  const abridor = page.locator(`#select2-${selectId}-container, [aria-labelledby*="${selectId}"]`).first();
  if (await abridor.count()) {
    await abridor.click();
  } else {
    // fallback: clica no elemento select2 irmão do select
    await page.locator(`#${selectId}`).evaluate((el) => {
      const s2 = el.nextElementSibling;
      if (s2 && s2.querySelector('.select2-selection')) s2.querySelector('.select2-selection').click();
    }).catch(() => {});
  }
  const busca = page.locator('input.select2-search__field');
  await busca.first().waitFor({ state: 'visible', timeout: 8000 });
  await busca.first().fill(String(texto));
  // Aguarda os resultados (AJAX) e escolhe o primeiro que não seja "carregando".
  await page.waitForTimeout(1500);
  const opcao = page.locator('li.select2-results__option[role="option"]').first();
  await opcao.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (await opcao.count()) await opcao.click();
  else if (log) log(`Aviso: nenhum resultado no select2 para "${texto}".`);
}

/** Marca um radio pelo name/id e valor (lidando com o estilo custom). */
async function marcarRadio(page, seletorBase, valor) {
  // Tenta pelo input com o value exato.
  const idBase = seletorBase.replace(/^#/, '');
  const input = page.locator(`input[name="${nomeDoId(idBase)}"][value="${valor}"], ${seletorBase}[value="${valor}"]`).first();
  if (await input.count()) {
    await input.check({ force: true }).catch(async () => {
      await input.evaluate((el) => { el.click(); });
    });
    return;
  }
  throw new Error(`Radio não encontrado: ${seletorBase} = ${valor}`);
}

/** Converte um id ASP.NET (Tomador_Inscricao) no name (Tomador.Inscricao). */
function nomeDoId(id) {
  return id.replace(/_/g, '.');
}

async function garantirTomadorBrasil(page) {
  // O painel Brasil (#pnlInscricaoBrasil) costuma já estar visível. Se houver
  // um seletor Brasil/Exterior, garante o Brasil.
  await page.evaluate(() => {
    const brasil = document.querySelector('#pnlInscricaoBrasil');
    if (brasil && brasil.offsetParent === null) {
      // tenta clicar num radio "Brasil" se existir
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      const rb = radios.find((r) => /brasil/i.test(r.closest('label')?.textContent || ''));
      if (rb) rb.click();
    }
  }).catch(() => {});
}

async function clicarAvancar(page) {
  const btn = page.locator('#btnAvancar, button[type="submit"]:has-text("Avançar"), button:has-text("Avançar")').first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
}

async function preencherData(page, seletor, ddmmaaaa) {
  const el = page.locator(seletor);
  await el.fill('');
  await el.type(ddmmaaaa, { delay: 20 });
  await page.keyboard.press('Escape').catch(() => {});
}

async function esperarPreenchido(page, seletor, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await page.locator(seletor).inputValue().catch(() => '');
    if (v && v.trim()) return true;
    await esperarMs(300);
  }
  return false;
}

function dataHoje() {
  // Sem depender de Date.now bloqueado em scripts: aqui é runtime normal.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatarValor(v) {
  // Aceita "1500,00" ou "1500.00" e devolve no formato do site (vírgula).
  return String(v).replace(/\./g, ',').replace(/,(?=.*,)/g, '');
}
