// Tradução dentro do navegador, em qualquer navegador (Chrome, Safari, Firefox):
// modelos de tradução (Marian/opus-mt) que rodam em WebAssembly no computador de
// quem opera o painel, como o app traduz no aparelho com o ML Kit. O TEXTO das
// mensagens nunca sai do computador. Só os modelos são baixados, uma vez, e ficam no
// cache do navegador (depois disso funciona offline).
//
// Dois modelos cobrem os quatro idiomas do Helper (pt, en, es, fr):
//   - ROMANCE-en: português, espanhol ou francês -> inglês
//   - en-ROMANCE: inglês -> português, espanhol ou francês (com ">>pt<<" no começo)
// Entre pt, es e fr a tradução passa pelo inglês. Cerca de 113 MB cada.
//
// O idioma é detectado com `franc-min` (detector de trigramas, uns 100 KB), já que
// só o Chrome tem detector embutido. Texto curto demais não é detectado (como no app).
//
// As bibliotecas vêm do jsDelivr, com a versão fixada; os modelos, do Hugging Face.
(function () {
  const BIBLIOTECA = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js';
  const DETECTOR = 'https://cdn.jsdelivr.net/npm/franc-min@6.2.0/+esm';
  const IDIOMAS = ['pt', 'en', 'es', 'fr'];
  const PARA_INGLES = 'Xenova/opus-mt-ROMANCE-en';
  const DO_INGLES = 'Xenova/opus-mt-en-ROMANCE';
  const ISO3 = { eng: 'en', spa: 'es', fra: 'fr', por: 'pt' };
  const MINIMO_PARA_DETECTAR = 12;

  let biblioteca = null;
  let detector = null;
  const pipelines = new Map(); // nome do modelo -> Promise<pipeline>
  const arquivos = new Map(); // modelo -> Map(arquivo -> { loaded, total }), para o progresso
  let emDownload = []; // os modelos do download em andamento
  let baixando = 0;

  function suportado() {
    return typeof WebAssembly === 'object';
  }

  function carregarBiblioteca() {
    biblioteca ??= import(BIBLIOTECA).then((m) => {
      m.env.allowLocalModels = false;
      // Uma thread só: não exige isolamento de origem (COOP/COEP), que o Safari pede.
      m.env.backends.onnx.wasm.numThreads = 1;
      return m;
    });
    biblioteca.catch(() => { biblioteca = null; });
    return biblioteca;
  }

  // Os modelos que o par precisa, ou null se o par não é suportado.
  function modelosDoPar(origem, destino) {
    if (!IDIOMAS.includes(origem) || !IDIOMAS.includes(destino) || origem === destino) return null;
    const modelos = [];
    if (origem !== 'en') modelos.push(PARA_INGLES);
    if (destino !== 'en') modelos.push(DO_INGLES);
    return modelos;
  }

  const chave = (nome) => 'helper_modelo_' + nome;
  function jaBaixado(nome) {
    try { return localStorage.getItem(chave(nome)) === '1'; } catch (e) { return false; }
  }
  function marcarBaixado(nome) {
    try { localStorage.setItem(chave(nome), '1'); } catch (e) { /* modo privado */ }
  }

  function aoProgredir(e) {
    if (!e || !e.file || !e.name) return;
    if (!arquivos.has(e.name)) arquivos.set(e.name, new Map());
    const dele = arquivos.get(e.name);
    if (e.status === 'progress' && e.total) dele.set(e.file, { loaded: e.loaded, total: e.total });
    else if (e.status === 'done' && dele.has(e.file)) {
      const a = dele.get(e.file);
      dele.set(e.file, { loaded: a.total, total: a.total });
    }
  }

  // 0 a 100: a média dos modelos do download em andamento (cada um conta igual).
  function progresso() {
    if (emDownload.length === 0) return 0;
    let soma = 0;
    for (const nome of emDownload) {
      if (jaBaixado(nome)) { soma += 1; continue; }
      let carregado = 0;
      let total = 0;
      for (const a of (arquivos.get(nome) || new Map()).values()) { carregado += a.loaded; total += a.total; }
      soma += total === 0 ? 0 : carregado / total;
    }
    return Math.min(100, Math.round((soma / emDownload.length) * 100));
  }

  function obter(nome) {
    if (!pipelines.has(nome)) {
      const p = carregarBiblioteca().then((m) =>
        m.pipeline('translation', nome, { dtype: 'q8', device: 'wasm', progress_callback: aoProgredir }));
      // Se falhar, não guarda: a próxima tentativa refaz.
      p.catch(() => pipelines.delete(nome));
      pipelines.set(nome, p);
    }
    return pipelines.get(nome);
  }

  // O código do idioma ("en"), ou "und" se não deu para saber.
  async function identificar(texto) {
    const t = String(texto || '').trim();
    if (t.length < MINIMO_PARA_DETECTAR) return 'und';
    try {
      detector ??= await import(DETECTOR);
      const codigo = detector.franc(t, { only: Object.keys(ISO3), minLength: MINIMO_PARA_DETECTAR });
      return ISO3[codigo] || 'und';
    } catch (e) {
      return 'und';
    }
  }

  // "available", "downloadable", "downloading" ou "unavailable".
  async function situacao(origem, destino) {
    if (!suportado()) return 'unavailable';
    const modelos = modelosDoPar(origem, destino);
    if (!modelos) return 'unavailable';
    if (modelos.every(jaBaixado)) return 'available';
    return baixando > 0 ? 'downloading' : 'downloadable';
  }

  // Baixa os modelos do par e deixa tudo pronto.
  async function preparar(origem, destino) {
    const modelos = modelosDoPar(origem, destino);
    if (!modelos) throw new Error('par de idiomas sem tradução');
    baixando += 1;
    emDownload = modelos;
    try {
      for (const nome of modelos) {
        await obter(nome);
        marcarBaixado(nome);
      }
    } finally {
      baixando -= 1;
    }
  }

  // Uma frase por vez: com duas frases juntas o modelo costuma traduzir só a
  // primeira. Quebra depois de . ! ? … seguidos de espaço (não em "8.30").
  function frases(linha) {
    return linha.split(/(?<=[.!?…])\s+/).filter((f) => f.trim() !== '');
  }

  async function traduzirTrecho(pipe, texto, prefixo) {
    const saida = await pipe(prefixo + texto, { max_new_tokens: 400 });
    let traducao = String(saida[0].translation_text);
    // Frase de uma ou duas palavras ("Obrigado."): o modelo costuma inventar mais
    // frases depois da tradução. Fica só com a primeira.
    if (texto.trim().split(/\s+/).length <= 2) traducao = frases(traducao)[0] || traducao;
    return traducao;
  }

  async function traduzir(texto, origem, destino) {
    const modelos = modelosDoPar(origem, destino);
    if (!modelos) throw new Error('par de idiomas sem tradução');
    // Uma linha por vez, e dentro dela uma frase por vez, mantendo as quebras.
    const linhas = String(texto).split(/\n+/).filter((l) => l.trim() !== '');
    const resultado = [];
    for (const linha of linhas) {
      const traduzidas = [];
      for (const frase of frases(linha)) {
        let atual = frase;
        if (origem !== 'en') atual = await traduzirTrecho(await obter(PARA_INGLES), atual, '');
        if (destino !== 'en') atual = await traduzirTrecho(await obter(DO_INGLES), atual, '>>' + destino + '<< ');
        traduzidas.push(atual);
      }
      resultado.push(traduzidas.join(' '));
    }
    for (const nome of modelos) marcarBaixado(nome);
    return resultado.join('\n');
  }

  window.tradutorDoNavegador = { suportado, identificar, situacao, preparar, traduzir, progresso };
})();
