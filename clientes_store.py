"""Armazenamento de clientes (nome + CNPJ) para a interface Python.

Usa o MESMO arquivo dados/clientes.json que o motor Node — os dois lados ficam
sincronizados. Contém dados pessoais: fica só na máquina (fora do Git).
"""

import json
import os
import re
import uuid

RAIZ = os.path.dirname(os.path.abspath(__file__))
ARQUIVO = os.path.join(RAIZ, "dados", "clientes.json")
SEED = os.path.join(RAIZ, "clientes-iniciais.json")


def limpar_cnpj(cnpj: str) -> str:
    return re.sub(r"\D", "", cnpj or "")


def formatar_cnpj(cnpj: str) -> str:
    c = limpar_cnpj(cnpj).zfill(14)[:14]
    return f"{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:14]}"


def cnpj_valido(cnpj: str) -> bool:
    c = limpar_cnpj(cnpj)
    if len(c) != 14 or c == c[0] * 14:
        return False

    def digito(base: str) -> int:
        soma = 0
        peso = len(base) - 7
        for ch in base:
            soma += int(ch) * peso
            peso = 9 if peso == 2 else peso - 1
        resto = soma % 11
        return 0 if resto < 2 else 11 - resto

    d1 = digito(c[:12])
    d2 = digito(c[:12] + str(d1))
    return c.endswith(f"{d1}{d2}")


def _garantir_dir():
    os.makedirs(os.path.dirname(ARQUIVO), exist_ok=True)


def _semear_se_necessario():
    if os.path.exists(ARQUIVO):
        return
    if not os.path.exists(SEED):
        return
    try:
        with open(SEED, encoding="utf-8") as f:
            seed = json.load(f)
    except Exception:
        return
    lista = []
    vistos = set()
    for s in seed:
        c = limpar_cnpj(s.get("cnpj", ""))
        if cnpj_valido(c) and c not in vistos:
            vistos.add(c)
            lista.append({"id": str(uuid.uuid4()), "nome": str(s.get("nome", "")).strip(), "cnpj": c})
    if lista:
        _salvar(lista)


def _salvar(lista):
    _garantir_dir()
    lista.sort(key=lambda x: (x.get("nome") or "").lower())
    with open(ARQUIVO, "w", encoding="utf-8") as f:
        json.dump(lista, f, ensure_ascii=False, indent=2)
    return lista


def listar():
    _semear_se_necessario()
    try:
        with open(ARQUIVO, encoding="utf-8") as f:
            dados = json.load(f)
        return dados if isinstance(dados, list) else []
    except Exception:
        return []


def _validar(nome, cnpj):
    nome_l = (nome or "").strip()
    c = limpar_cnpj(cnpj)
    if not nome_l:
        raise ValueError("Nome é obrigatório.")
    if not cnpj_valido(c):
        raise ValueError(f"CNPJ inválido: {cnpj}")
    return nome_l, c


def adicionar(nome, cnpj):
    nome_l, c = _validar(nome, cnpj)
    lista = listar()
    if any(limpar_cnpj(x["cnpj"]) == c for x in lista):
        raise ValueError("Já existe um cliente com esse CNPJ.")
    cliente = {"id": str(uuid.uuid4()), "nome": nome_l, "cnpj": c}
    lista.append(cliente)
    _salvar(lista)
    return cliente


def editar(id_, nome, cnpj):
    lista = listar()
    i = next((k for k, x in enumerate(lista) if x["id"] == id_), -1)
    if i < 0:
        raise ValueError("Cliente não encontrado.")
    nome_l, c = _validar(nome, cnpj)
    if any(x["id"] != id_ and limpar_cnpj(x["cnpj"]) == c for x in lista):
        raise ValueError("Já existe outro cliente com esse CNPJ.")
    lista[i] = {**lista[i], "nome": nome_l, "cnpj": c}
    _salvar(lista)
    return lista[i]


def remover(id_):
    lista = listar()
    nova = [x for x in lista if x["id"] != id_]
    if len(nova) == len(lista):
        raise ValueError("Cliente não encontrado.")
    _salvar(nova)


def importar_texto(texto: str):
    linhas = [l.strip() for l in (texto or "").splitlines() if l.strip()]
    lista = listar()
    existentes = {limpar_cnpj(x["cnpj"]) for x in lista}
    adicionados = 0
    ignorados = []
    for linha in linhas:
        m = re.search(r"(\d[\d.\-/]{15,}\d)", linha)
        cnpj = limpar_cnpj(m.group(1)) if m else ""
        nome = (linha.replace(m.group(1), "") if m else linha)
        nome = re.sub(r"[\t;]+", " ", nome)
        nome = re.sub(r"\s{2,}", " ", nome).strip().rstrip("-–").strip()
        if not cnpj_valido(cnpj):
            ignorados.append((linha, "CNPJ inválido ou não encontrado"))
            continue
        if not nome:
            ignorados.append((linha, "Nome não encontrado"))
            continue
        if cnpj in existentes:
            ignorados.append((linha, "CNPJ já cadastrado"))
            continue
        lista.append({"id": str(uuid.uuid4()), "nome": nome, "cnpj": cnpj})
        existentes.add(cnpj)
        adicionados += 1
    _salvar(lista)
    return adicionados, ignorados
