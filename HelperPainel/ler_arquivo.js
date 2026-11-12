// Abre o seletor de arquivo do navegador e devolve o texto do arquivo escolhido
// (ou null se a pessoa cancelar). O arquivo é lido no computador: não sobe para lugar nenhum.
window.lerArquivoDeTexto = function () {
  return new Promise(function (resolve) {
    var entrada = document.createElement('input');
    entrada.type = 'file';
    entrada.accept = '.txt,.csv,text/plain,text/csv';
    entrada.style.display = 'none';
    entrada.addEventListener('change', function () {
      var arquivo = entrada.files && entrada.files[0];
      if (!arquivo) { resolve(null); return; }
      var leitor = new FileReader();
      leitor.onload = function () { resolve(String(leitor.result)); };
      leitor.onerror = function () { resolve(null); };
      leitor.readAsText(arquivo);
    });
    entrada.addEventListener('cancel', function () { resolve(null); });
    document.body.appendChild(entrada);
    entrada.click();
  });
};
