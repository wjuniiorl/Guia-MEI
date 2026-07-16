#!/usr/bin/env node
// CLI para emissão do DAS do MEI.
//
// Uso:
//   node src/cli.js --cnpj 29249163000194 --ano 2026 --mes 6
//   node src/cli.js -c 29.249.163/0001-94 -a 2026 -m 6 --out ./guias
//
// No modo padrão ('chrome'): a ferramenta abre o SEU Chrome/Edge real, você faz
// a identificação (CNPJ + Continuar + captcha) manualmente e, ao voltar aqui e
// teclar ENTER, a automação assume e emite/baixa o PDF. Nenhuma automação toca
// no navegador durante a identificação — é o que despista o hCaptcha.

import readline from 'node:readline';
import { emitirDAS, cnpjValido, formatarCnpj } from './pgmei.js';

function parseArgs(argv) {
  const args = {};
  const alias = { c: 'cnpj', a: 'ano', m: 'mes', o: 'out', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    if (!key.startsWith('-')) continue;
    key = key.replace(/^--?/, '');
    if (key === 'help' || key === 'h') { args.help = true; continue; }
    key = alias[key] || key;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

function ajuda() {
  console.log(`
Guia-MEI — Emissão automática do DAS (PGMEI)

Uso:
  node src/cli.js --cnpj <CNPJ> --ano <ANO> --mes <MES> [opções]

Opções:
  --cnpj, -c   CNPJ (com ou sem formatação)          [obrigatório]
  --ano,  -a   Ano-calendário (ex: 2026)             [obrigatório]
  --mes,  -m   Mês de apuração (1..12)               [obrigatório]
  --out,  -o   Diretório de saída (default: ./downloads)
  --modo       chrome | headless | headful (default: chrome)
  --novo-perfil  Recopia seu perfil do Chrome (use se o captcha voltar a bloquear)
  --help, -h   Mostra esta ajuda

Modo 'chrome' (padrão): abre o seu Chrome/Edge real usando uma CÓPIA do seu
perfil (cookies/histórico) para o hCaptcha confiar no navegador. Você faz a
identificação (CNPJ + captcha) e tecla ENTER aqui; a automação emite e baixa o
PDF. IMPORTANTE: feche todas as janelas do Chrome antes da 1ª execução (para eu
copiar o perfil). Use CHROME_PATH para apontar o executável, se necessário.

Exemplo:
  node src/cli.js -c 29249163000194 -a 2026 -m 6
`);
}

/** Aguarda o usuário teclar ENTER. */
function esperarEnter(mensagem) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(mensagem, () => { rl.close(); resolve(); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.cnpj && !args.ano && !args.mes)) {
    ajuda();
    process.exit(args.help ? 0 : 1);
  }

  const faltando = [];
  if (!args.cnpj) faltando.push('--cnpj');
  if (!args.ano) faltando.push('--ano');
  if (!args.mes) faltando.push('--mes');
  if (faltando.length) {
    console.error(`Erro: parâmetros obrigatórios ausentes: ${faltando.join(', ')}`);
    ajuda();
    process.exit(1);
  }

  if (!cnpjValido(args.cnpj)) {
    console.error(`Erro: CNPJ inválido: ${args.cnpj}`);
    process.exit(1);
  }

  const modo = ['chrome', 'headless', 'headful'].includes(args.modo) ? args.modo : 'chrome';

  try {
    const resultado = await emitirDAS({
      cnpj: args.cnpj,
      ano: args.ano,
      mes: args.mes,
      modo,
      outputDir: args.out,
      reSemear: Boolean(args['novo-perfil']),
      onLog: (msg) => console.log(`  › ${msg}`),
      // No modo chrome, aguarda o ENTER após a identificação manual.
      confirmar: modo === 'chrome'
        ? () => esperarEnter('\n  ➤ Depois de estar identificado na janela, tecle ENTER aqui para continuar... ')
        : undefined,
    });

    console.log('\n✅ DAS emitido com sucesso!');
    console.log(`   Contribuinte: ${resultado.nome || '(não identificado)'}`);
    console.log(`   Período:      ${resultado.periodo}`);
    if (resultado.valor) console.log(`   Valor:        ${resultado.valor}`);
    console.log(`   Arquivo:      ${resultado.pdfPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Falha na emissão: ${err.message}`);
    process.exit(1);
  }
}

main();
