#!/usr/bin/env node
// CLI de teste para a emissão de NFS-e.
//
// Testar SÓ o login primeiro (recomendado):
//   node src/nfse-cli.js --login 00000000000 --senha SUASENHA --so-login
//
// Emissão completa:
//   node src/nfse-cli.js --login <CPF/CNPJ> --senha <SENHA> \
//     --municipio "São Paulo" --tomador 11222333000181 --valor 1500,00 \
//     --codigo 01.05 --aliquota 6,00 --descricao "Serviços de contabilidade"
//
// Opções: --data dd/mm/aaaa | --regime 1|2|3 | --min | --novo-perfil | --so-login

import { emitirNFSe } from './nfse.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i];
    if (!k.startsWith('--')) continue;
    k = k.slice(2);
    const flags = ['so-login', 'min', 'novo-perfil'];
    if (flags.includes(k)) { args[k] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[k] = next; i++; }
    else args[k] = true;
  }
  return args;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.login || !a.senha) {
    console.error('Uso: node src/nfse-cli.js --login <CPF/CNPJ> --senha <SENHA> [--so-login | campos da nota]');
    process.exit(1);
  }
  try {
    const r = await emitirNFSe({
      login: a.login,
      senha: a.senha,
      municipio: a.municipio,
      tomador: a.tomador,
      valor: a.valor,
      dataCompetencia: a.data,
      codigoServico: a.codigo,
      aliquota: a.aliquota,
      descricao: a.descricao,
      regimeSN: a.regime || 1,
      minimizar: Boolean(a.min),
      novoPerfil: Boolean(a['novo-perfil']),
      pararAposLogin: Boolean(a['so-login']),
      onLog: (m) => console.log(`  › ${m}`),
    });
    console.log('\n✅', r.mensagem || 'Concluído.');
    if (r.numero) console.log('   NFS-e nº:', r.numero);
    if (r.pdfPath) console.log('   PDF:', r.pdfPath);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Falha: ${err.message}`);
    process.exit(1);
  }
}

main();
