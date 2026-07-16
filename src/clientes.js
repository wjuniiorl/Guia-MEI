// Gerenciamento da lista de clientes (nome + CNPJ), salva LOCALMENTE em
// dados/clientes.json. Esse arquivo fica fora do Git (ver .gitignore) porque
// contém dados pessoais dos clientes — nunca vai para o repositório.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { limparCnpj, cnpjValido, formatarCnpj } from './pgmei.js';

const ARQUIVO = path.resolve(process.cwd(), 'dados', 'clientes.json');
const SEED = path.resolve(process.cwd(), 'clientes-iniciais.json');

function garantirDir() {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
}

/**
 * Na primeira vez (quando ainda não existe dados/clientes.json), importa a
 * lista inicial de clientes-iniciais.json, se houver. Depois disso, o arquivo
 * do usuário manda — a seed não é reaplicada.
 */
function semearSeNecessario() {
  if (fs.existsSync(ARQUIVO)) return;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(SEED, 'utf8')); } catch { return; }
  if (!Array.isArray(seed) || !seed.length) return;
  const lista = [];
  for (const s of seed) {
    const c = limparCnpj(s.cnpj);
    if (cnpjValido(c) && !lista.some((x) => x.cnpj === c)) {
      lista.push({ id: crypto.randomUUID(), nome: String(s.nome || '').trim(), cnpj: c });
    }
  }
  if (lista.length) salvar(lista);
}

/** Lê a lista de clientes (ordenada por nome). */
export function listarClientes() {
  semearSeNecessario();
  try {
    const lista = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

function salvar(lista) {
  garantirDir();
  lista.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
  return lista;
}

function validar(nome, cnpj) {
  const nomeLimpo = String(nome || '').trim();
  const c = limparCnpj(cnpj);
  if (!nomeLimpo) throw new Error('Nome é obrigatório.');
  if (!cnpjValido(c)) throw new Error(`CNPJ inválido: ${cnpj}`);
  return { nomeLimpo, cnpjLimpo: c };
}

/** Adiciona um cliente. Lança erro se o CNPJ já existir. */
export function adicionarCliente({ nome, cnpj }) {
  const { nomeLimpo, cnpjLimpo } = validar(nome, cnpj);
  const lista = listarClientes();
  if (lista.some((x) => limparCnpj(x.cnpj) === cnpjLimpo)) {
    throw new Error('Já existe um cliente com esse CNPJ.');
  }
  const cliente = { id: crypto.randomUUID(), nome: nomeLimpo, cnpj: cnpjLimpo };
  lista.push(cliente);
  salvar(lista);
  return cliente;
}

/** Edita um cliente existente. */
export function editarCliente(id, { nome, cnpj }) {
  const lista = listarClientes();
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('Cliente não encontrado.');
  const { nomeLimpo, cnpjLimpo } = validar(nome, cnpj);
  if (lista.some((x) => x.id !== id && limparCnpj(x.cnpj) === cnpjLimpo)) {
    throw new Error('Já existe outro cliente com esse CNPJ.');
  }
  lista[i] = { ...lista[i], nome: nomeLimpo, cnpj: cnpjLimpo };
  salvar(lista);
  return lista[i];
}

/** Remove um cliente pelo id. */
export function removerCliente(id) {
  const lista = listarClientes();
  const nova = lista.filter((x) => x.id !== id);
  if (nova.length === lista.length) throw new Error('Cliente não encontrado.');
  salvar(nova);
  return true;
}

/**
 * Importa vários clientes de um texto colado (uma linha por cliente).
 * Cada linha deve conter o CNPJ (com ou sem formatação) e o nome — em qualquer
 * ordem, separados por tab, ; ou vários espaços. Ex.:
 *   ADEMIR   46.609.505/0001-59
 *   28.699.168/0001-56  ANDREA C DA SILVA OTICA
 * Retorna { adicionados, ignorados: [{linha, motivo}] }.
 */
export function importarTexto(texto) {
  const linhas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lista = listarClientes();
  const existentes = new Set(lista.map((x) => limparCnpj(x.cnpj)));
  const adicionados = [];
  const ignorados = [];

  for (const linha of linhas) {
    // Acha um CNPJ na linha (14 dígitos, com ou sem máscara).
    const m = linha.match(/(\d[\d.\-/]{15,}\d)/);
    const cnpj = m ? limparCnpj(m[1]) : '';
    let nome = m ? linha.replace(m[1], '') : linha;
    nome = nome.replace(/[\t;]+/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[-–]\s*$/, '').trim();

    if (!cnpjValido(cnpj)) { ignorados.push({ linha, motivo: 'CNPJ inválido ou não encontrado' }); continue; }
    if (!nome) { ignorados.push({ linha, motivo: 'Nome não encontrado' }); continue; }
    if (existentes.has(cnpj)) { ignorados.push({ linha, motivo: 'CNPJ já cadastrado' }); continue; }

    const cliente = { id: crypto.randomUUID(), nome, cnpj };
    lista.push(cliente);
    existentes.add(cnpj);
    adicionados.push(cliente);
  }

  salvar(lista);
  return { adicionados: adicionados.length, ignorados };
}

export { formatarCnpj };
