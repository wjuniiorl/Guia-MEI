"""Guia-MEI — Interface desktop (CustomTkinter).

Janela nativa para emitir o DAS do MEI e gerenciar clientes. A emissão é feita
pelo motor Node que já existe (src/cli.js), chamado por baixo dos panos — assim
reaproveitamos toda a lógica anti-captcha que já funciona.

Requisitos: Python 3.9+, Node.js instalado, e:  pip install customtkinter
Rodar:  python app.py
"""

import os
import queue
import shutil
import subprocess
import sys
import threading
from datetime import datetime

import customtkinter as ctk
from tkinter import messagebox

import clientes_store as store

RAIZ = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(RAIZ, "src", "cli.js")
MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
         "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]

ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Guia-MEI · Emissão do DAS")
        self.geometry("880x680")
        self.minsize(780, 600)

        self.fila = queue.Queue()
        self.emitindo = False
        self.check_clientes = {}   # id -> CTkCheckBox (aba emitir)
        self.check_meses = {}      # num -> CTkCheckBox
        self.editando_id = None

        self._montar()
        self._carregar_clientes()
        self.after(120, self._processar_fila)

    # ------------------------------------------------------------------ UI
    def _montar(self):
        cab = ctk.CTkFrame(self, corner_radius=0, fg_color="#1351b4")
        cab.pack(fill="x")
        ctk.CTkLabel(cab, text="Guia-MEI", font=("Segoe UI", 22, "bold"),
                     text_color="white").pack(anchor="w", padx=18, pady=(12, 0))
        ctk.CTkLabel(cab, text="Emissão automática do DAS do MEI",
                     font=("Segoe UI", 12), text_color="#dbe6fb").pack(anchor="w", padx=18, pady=(0, 12))

        self.tabs = ctk.CTkTabview(self, corner_radius=10)
        self.tabs.pack(fill="both", expand=True, padx=12, pady=12)
        self.tab_emitir = self.tabs.add("  Emitir DAS  ")
        self.tab_clientes = self.tabs.add("  Clientes  ")
        self._montar_emitir(self.tab_emitir)
        self._montar_clientes(self.tab_clientes)

    def _montar_emitir(self, tab):
        tab.grid_columnconfigure(0, weight=1)
        tab.grid_columnconfigure(1, weight=1)
        tab.grid_rowconfigure(2, weight=1)

        # Coluna esquerda: clientes
        esq = ctk.CTkFrame(tab)
        esq.grid(row=0, column=0, rowspan=3, sticky="nsew", padx=(0, 8), pady=0)
        ctk.CTkLabel(esq, text="Clientes", font=("Segoe UI", 13, "bold")).pack(anchor="w", padx=12, pady=(10, 2))
        barra = ctk.CTkFrame(esq, fg_color="transparent")
        barra.pack(fill="x", padx=8)
        ctk.CTkButton(barra, text="Marcar todos", width=110, height=26,
                      command=lambda: self._marcar_clientes(True)).pack(side="left", padx=2)
        ctk.CTkButton(barra, text="Limpar", width=70, height=26, fg_color="gray40",
                      command=lambda: self._marcar_clientes(False)).pack(side="left", padx=2)
        self.lista_clientes = ctk.CTkScrollableFrame(esq, label_text="")
        self.lista_clientes.pack(fill="both", expand=True, padx=8, pady=8)

        # Coluna direita: opções
        dir_ = ctk.CTkFrame(tab)
        dir_.grid(row=0, column=1, sticky="new", padx=(8, 0))
        ctk.CTkLabel(dir_, text="Ano-calendário", font=("Segoe UI", 12, "bold")).pack(anchor="w", padx=12, pady=(12, 2))
        ano_atual = datetime.now().year
        self.opt_ano = ctk.CTkOptionMenu(dir_, values=[str(a) for a in range(ano_atual, ano_atual - 6, -1)])
        self.opt_ano.pack(anchor="w", padx=12)

        ctk.CTkLabel(dir_, text="Meses", font=("Segoe UI", 12, "bold")).pack(anchor="w", padx=12, pady=(14, 2))
        grade = ctk.CTkFrame(dir_, fg_color="transparent")
        grade.pack(fill="x", padx=8)
        for i, nome in enumerate(MESES):
            var = ctk.StringVar(value="off")
            chk = ctk.CTkCheckBox(grade, text=nome, variable=var, onvalue="on", offvalue="off",
                                  width=100)
            chk.grid(row=i // 3, column=i % 3, sticky="w", padx=6, pady=4)
            self.check_meses[i + 1] = chk

        self.sw_invisivel = ctk.CTkSwitch(dir_, text="Janela invisível (não mostra o Chrome)")
        self.sw_invisivel.pack(anchor="w", padx=12, pady=(14, 4))

        self.btn_emitir = ctk.CTkButton(dir_, text="Emitir DAS", height=40,
                                        font=("Segoe UI", 14, "bold"), fg_color="#168821",
                                        hover_color="#0f6b1a", command=self._emitir)
        self.btn_emitir.pack(fill="x", padx=12, pady=12)

        # Log
        logf = ctk.CTkFrame(tab)
        logf.grid(row=1, column=1, rowspan=2, sticky="nsew", padx=(8, 0), pady=(8, 0))
        logf.grid_rowconfigure(1, weight=1)
        logf.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(logf, text="Progresso", font=("Segoe UI", 12, "bold")).grid(row=0, column=0, sticky="w", padx=12, pady=(8, 2))
        self.txt_log = ctk.CTkTextbox(logf, font=("Consolas", 11), wrap="word")
        self.txt_log.grid(row=1, column=0, sticky="nsew", padx=8, pady=8)
        self.txt_log.configure(state="disabled")

    def _montar_clientes(self, tab):
        tab.grid_columnconfigure(0, weight=1)
        tab.grid_rowconfigure(2, weight=1)

        form = ctk.CTkFrame(tab)
        form.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        form.grid_columnconfigure(1, weight=1)
        self.lbl_form = ctk.CTkLabel(form, text="Adicionar cliente", font=("Segoe UI", 13, "bold"))
        self.lbl_form.grid(row=0, column=0, columnspan=3, sticky="w", padx=12, pady=(10, 4))
        ctk.CTkLabel(form, text="Nome").grid(row=1, column=0, sticky="w", padx=12)
        self.ent_nome = ctk.CTkEntry(form, placeholder_text="Ex.: MARIA DO ROSARIO")
        self.ent_nome.grid(row=1, column=1, columnspan=2, sticky="ew", padx=12, pady=4)
        ctk.CTkLabel(form, text="CNPJ").grid(row=2, column=0, sticky="w", padx=12)
        self.ent_cnpj = ctk.CTkEntry(form, placeholder_text="00.000.000/0000-00")
        self.ent_cnpj.grid(row=2, column=1, columnspan=2, sticky="ew", padx=12, pady=4)
        self.btn_salvar = ctk.CTkButton(form, text="Adicionar", command=self._salvar_cliente)
        self.btn_salvar.grid(row=3, column=1, sticky="e", padx=6, pady=10)
        self.btn_cancelar = ctk.CTkButton(form, text="Cancelar", fg_color="gray40", command=self._cancelar_edicao)
        self.btn_cancelar.grid(row=3, column=2, sticky="e", padx=(0, 12), pady=10)
        self.btn_cancelar.grid_remove()

        imp = ctk.CTkFrame(tab)
        imp.grid(row=1, column=0, sticky="ew", pady=8)
        imp.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(imp, text="Importar vários (cole a lista: nome e CNPJ por linha)",
                     font=("Segoe UI", 12, "bold")).grid(row=0, column=0, sticky="w", padx=12, pady=(10, 4))
        self.txt_import = ctk.CTkTextbox(imp, height=90)
        self.txt_import.grid(row=1, column=0, sticky="ew", padx=12)
        ctk.CTkButton(imp, text="Importar lista", command=self._importar).grid(row=2, column=0, sticky="e", padx=12, pady=8)

        listf = ctk.CTkFrame(tab)
        listf.grid(row=2, column=0, sticky="nsew")
        listf.grid_rowconfigure(1, weight=1)
        listf.grid_columnconfigure(0, weight=1)
        self.lbl_qtd = ctk.CTkLabel(listf, text="Clientes cadastrados", font=("Segoe UI", 13, "bold"))
        self.lbl_qtd.grid(row=0, column=0, sticky="w", padx=12, pady=(10, 2))
        self.lista_gerenciar = ctk.CTkScrollableFrame(listf)
        self.lista_gerenciar.grid(row=1, column=0, sticky="nsew", padx=8, pady=8)

    # -------------------------------------------------------------- Dados
    def _carregar_clientes(self):
        clientes = store.listar()
        # aba emitir (checkboxes)
        for w in self.lista_clientes.winfo_children():
            w.destroy()
        self.check_clientes.clear()
        for c in clientes:
            var = ctk.StringVar(value="off")
            chk = ctk.CTkCheckBox(self.lista_clientes, variable=var, onvalue="on", offvalue="off",
                                  text=f"{c['nome']}  ·  {store.formatar_cnpj(c['cnpj'])}")
            chk.pack(anchor="w", padx=6, pady=3, fill="x")
            chk._cnpj = c["cnpj"]
            chk._nome = c["nome"]
            self.check_clientes[c["id"]] = chk

        # aba gerenciar
        for w in self.lista_gerenciar.winfo_children():
            w.destroy()
        self.lbl_qtd.configure(text=f"Clientes cadastrados ({len(clientes)})")
        for c in clientes:
            linha = ctk.CTkFrame(self.lista_gerenciar, fg_color="transparent")
            linha.pack(fill="x", pady=2)
            ctk.CTkLabel(linha, text=f"{c['nome']}", anchor="w", width=280).pack(side="left", padx=(4, 6))
            ctk.CTkLabel(linha, text=store.formatar_cnpj(c["cnpj"]), anchor="w",
                         text_color="gray").pack(side="left")
            ctk.CTkButton(linha, text="Excluir", width=70, height=26, fg_color="#c92a2a",
                          hover_color="#a4262c", command=lambda cid=c["id"], n=c["nome"]: self._excluir(cid, n)).pack(side="right", padx=2)
            ctk.CTkButton(linha, text="Editar", width=70, height=26,
                          command=lambda cc=c: self._editar(cc)).pack(side="right", padx=2)

    def _marcar_clientes(self, valor):
        for chk in self.check_clientes.values():
            chk.select() if valor else chk.deselect()

    def _salvar_cliente(self):
        nome = self.ent_nome.get().strip()
        cnpj = self.ent_cnpj.get().strip()
        try:
            if self.editando_id:
                store.editar(self.editando_id, nome, cnpj)
            else:
                store.adicionar(nome, cnpj)
        except ValueError as e:
            messagebox.showerror("Erro", str(e))
            return
        self._cancelar_edicao()
        self._carregar_clientes()

    def _editar(self, cliente):
        self.editando_id = cliente["id"]
        self.ent_nome.delete(0, "end"); self.ent_nome.insert(0, cliente["nome"])
        self.ent_cnpj.delete(0, "end"); self.ent_cnpj.insert(0, store.formatar_cnpj(cliente["cnpj"]))
        self.lbl_form.configure(text="Editar cliente")
        self.btn_salvar.configure(text="Salvar alterações")
        self.btn_cancelar.grid()

    def _cancelar_edicao(self):
        self.editando_id = None
        self.ent_nome.delete(0, "end"); self.ent_cnpj.delete(0, "end")
        self.lbl_form.configure(text="Adicionar cliente")
        self.btn_salvar.configure(text="Adicionar")
        self.btn_cancelar.grid_remove()

    def _excluir(self, cid, nome):
        if messagebox.askyesno("Excluir", f'Excluir o cliente "{nome}"?'):
            store.remover(cid)
            self._carregar_clientes()

    def _importar(self):
        texto = self.txt_import.get("1.0", "end")
        if not texto.strip():
            return
        adicionados, ignorados = store.importar_texto(texto)
        self.txt_import.delete("1.0", "end")
        self._carregar_clientes()
        msg = f"{adicionados} cliente(s) importado(s)."
        if ignorados:
            msg += f"\n{len(ignorados)} linha(s) ignorada(s)."
        messagebox.showinfo("Importar", msg)

    # ----------------------------------------------------------- Emissão
    def _emitir(self):
        if self.emitindo:
            return
        selecionados = [(chk._nome, chk._cnpj) for chk in self.check_clientes.values() if chk.get() == "on"]
        meses = [n for n, chk in self.check_meses.items() if chk.get() == "on"]
        ano = self.opt_ano.get()
        if not selecionados:
            messagebox.showwarning("Atenção", "Selecione ao menos um cliente.")
            return
        if not meses:
            messagebox.showwarning("Atenção", "Selecione ao menos um mês.")
            return
        if not shutil.which("node"):
            messagebox.showerror("Node não encontrado",
                                 "O Node.js não foi encontrado. Instale em https://nodejs.org e reabra.")
            return

        self.emitindo = True
        self.btn_emitir.configure(state="disabled", text="Emitindo...")
        self._log_limpar()
        invisivel = self.sw_invisivel.get() == 1
        t = threading.Thread(target=self._worker, args=(selecionados, ano, meses, invisivel), daemon=True)
        t.start()

    def _worker(self, selecionados, ano, meses, invisivel):
        meses_str = ",".join(str(m) for m in meses)
        total = len(selecionados)
        for idx, (nome, cnpj) in enumerate(selecionados, 1):
            self.fila.put(("log", f"\n===== [{idx}/{total}] {nome} ====="))
            cmd = ["node", CLI, "-c", cnpj, "-a", str(ano), "-m", meses_str, "--auto"]
            if invisivel:
                cmd.append("--min")
            try:
                flags = 0
                if sys.platform == "win32":
                    flags = 0x08000000  # CREATE_NO_WINDOW (não abre console do node)
                proc = subprocess.Popen(cmd, cwd=RAIZ, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, encoding="utf-8", errors="replace", creationflags=flags)
                for linha in proc.stdout:
                    self.fila.put(("log", linha.rstrip()))
                proc.wait()
            except Exception as e:
                self.fila.put(("log", f"ERRO ao executar: {e}"))
        self.fila.put(("fim", None))

    def _processar_fila(self):
        try:
            while True:
                tipo, dado = self.fila.get_nowait()
                if tipo == "log":
                    self._log(dado)
                elif tipo == "fim":
                    self.emitindo = False
                    self.btn_emitir.configure(state="normal", text="Emitir DAS")
                    self._log("\n✅ Concluído. Os PDFs estão na pasta downloads/ANO/MÊS.")
        except queue.Empty:
            pass
        self.after(120, self._processar_fila)

    def _log(self, texto):
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", texto + "\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _log_limpar(self):
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")


if __name__ == "__main__":
    App().mainloop()
