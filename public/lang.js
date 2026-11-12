'use strict';

// Translations. English is the fallback for any missing line. `srv` holds the
// short labels the server sends (format hints and option names), keyed by
// their English text. To add a language, copy one block and translate it.
//
// Text from here is only ever placed with textContent or as an attribute
// value, never as HTML.
window.i18n = (() => {
  const en = {
    lead: "Drop in a link or type a song's name, and I'll bring it back as a proper music file, with the right title, album art and lyrics tucked inside.",
    placeholder: 'Paste links, or type a song name',
    go: 'Get it', goSearch: 'Search', formatLabel: 'Format',
    optLyrics: 'Add lyrics when I can find them', optSynced: 'Prefer time-synced lyrics (.lrc)', optNormalize: 'Even out the loudness',
    optAuto: "Download as soon as it's ready", optAlbum: 'Treat a playlist as one album',
    tabMusic: 'Your music', tabInspect: 'Inspect a file',
    emptyTitle: "It's quiet in here.", emptyText: "Paste a link on the left and your music will show up the moment it's ready.",
    inspectTitle: "What's inside this file?",
    inspectText: "Drop an audio file ({types}) and I'll read its tags, artwork and audio details. It's read once and deleted straight away.",
    dropText: 'Drop a file here, or click to choose one', inspectKind: 'That kind of file is not accepted here. This server reads {types}.', inspectBig: 'That file is larger than {mb} MB.',
    madeBy: 'Made with care by', privacy: 'Privacy', footNote: 'Only download what you have the right to.',
    lockTitle: "This one's private", lockText: 'Enter the password to come in.', unlock: 'Unlock',
    themeAria: 'Switch between light and dark theme', meterTitle: 'Space your finished files are using on the server', langAria: 'Language',
    upLate: 'Up late?', morning: 'Good morning.', afternoon: 'Good afternoon.', evening: 'Good evening.', greetTail: 'What are we listening to?',
    queued: 'Waiting for its turn…', downloading: 'Fetching the audio… {n}%', tagging: 'Finding the album, artwork and lyrics…', converting: 'Converting and tagging…',
    trackError: 'That one did not work.', collected: 'Downloaded and removed from the server', noArtist: 'No artist found', trackNo: 'track {n}',
    matchedOn: 'matched on {source}', lookupFailed: 'lookup failed, try again', noMatch: 'no catalogue match', edited: 'edited by you', fullFrom: 'full song from {source}',
    artwork: 'artwork', lyrics: 'lyrics', syncedLyrics: 'synced lyrics', levelled: 'levelled {db} dB',
    download: 'Download', downloadAll: 'Download all', remove: 'Remove', play: 'Play', pause: 'Pause', volume: 'Volume', mute: 'Mute', unmute: 'Unmute', edit: 'Edit tags', lrc: 'Lyrics file (.lrc)',
    inQueue: 'In the queue…', looking: 'Taking a look at your link…',
    expiry: 'Waiting for you for {n} more minutes.', expirySoon: 'About to be cleared. Grab it now.',
    meter: '{used} of {quota} GB waiting',
    toastPlaylist: 'Your playlist is on its way.', toastSong: 'Your song is on its way.',
    needLink: 'Paste a link or type a song name first.',
    searching: 'Searching…', noResults: 'Nothing found for that. Try other words.', pick: 'Pick the one you mean:', close: 'Close',
    tooManyLinks: 'That is more than {n} links. Paste fewer at a time.',
    fineprint: 'Finished files wait for you for {min} minutes and are deleted from the server the moment you download them. You can have up to {gb} GB waiting at a time; download and the space is yours again.',
    sitesNote: 'Works with {sites} links.',
    noServer: "I can't reach the server right now. Refresh in a moment.", missingTools: 'The server is missing yt-dlp or ffmpeg, so downloads will not work yet.',
    reading: 'Reading {name}…', embeddedArt: 'Embedded artwork',
    secAudio: 'Audio', secTags: 'Tags', secRaw: 'Raw {type}',
    container: 'Container', codec: 'Codec', lossless: 'Lossless', yes: 'yes', no: 'no', sampleRate: 'Sample rate', bitDepth: 'Bit depth',
    channels: 'Channels', bitrate: 'Bitrate', duration: 'Duration', tagFormats: 'Tag formats', artworkRow: 'Artwork', none: 'none',
    fTitle: 'Title', fArtist: 'Artist', fAlbum: 'Album', fAlbumArtist: 'Album artist', fYear: 'Year', fTrack: 'Track', fOf: 'of', fGenre: 'Genre',
    findAgain: 'Find it again', chooseCover: 'Choose a cover…', coverChosen: 'New cover: {name}', save: 'Save', cancel: 'Cancel',
    saving: 'Saving…', finding: 'Looking…', foundOn: 'Found on {source}. Check the details, then save.', foundCover: 'Its album art will be used.',
    coverTooBig: 'That image is larger than {mb} MB.', saved: 'Saved.',
    shared: 'Link received. Pick a format and press Get it.',
    oops: 'Something went wrong. Please try again.',
    srv: {},
  };

  const es = {
    lead: 'Pega un enlace o escribe el nombre de una canción y te la devuelvo como un archivo de música en condiciones, con su título, su carátula y la letra dentro.',
    placeholder: 'Pega enlaces o escribe el nombre de una canción',
    go: 'Traer', goSearch: 'Buscar', formatLabel: 'Formato',
    optLyrics: 'Añadir la letra si la encuentro', optSynced: 'Preferir letra sincronizada (.lrc)', optNormalize: 'Igualar el volumen',
    optAuto: 'Descargar en cuanto esté listo', optAlbum: 'Tratar una lista como un álbum',
    tabMusic: 'Tu música', tabInspect: 'Inspeccionar un archivo',
    emptyTitle: 'Aquí hay mucho silencio.', emptyText: 'Pega un enlace a la izquierda y tu música aparecerá en cuanto esté lista.',
    inspectTitle: '¿Qué hay dentro de este archivo?',
    inspectText: 'Suelta un archivo de audio ({types}) y leeré sus etiquetas, su carátula y sus datos de audio. Se lee una vez y se borra enseguida.',
    dropText: 'Suelta un archivo aquí o haz clic para elegir uno', inspectKind: 'Ese tipo de archivo no se acepta aquí. Este servidor lee {types}.', inspectBig: 'Ese archivo supera los {mb} MB.',
    madeBy: 'Hecho con cariño por', privacy: 'Privacidad', footNote: 'Descarga solo aquello a lo que tengas derecho.',
    lockTitle: 'Esto es privado', lockText: 'Escribe la contraseña para entrar.', unlock: 'Entrar',
    themeAria: 'Cambiar entre tema claro y oscuro', meterTitle: 'Espacio que ocupan tus archivos terminados en el servidor', langAria: 'Idioma',
    upLate: '¿Trasnochando?', morning: 'Buenos días.', afternoon: 'Buenas tardes.', evening: 'Buenas noches.', greetTail: '¿Qué escuchamos?',
    queued: 'Esperando su turno…', downloading: 'Trayendo el audio… {n}%', tagging: 'Buscando el álbum, la carátula y la letra…', converting: 'Convirtiendo y etiquetando…',
    trackError: 'Esta no ha funcionado.', collected: 'Descargado y borrado del servidor', noArtist: 'Artista no encontrado', trackNo: 'pista {n}',
    matchedOn: 'encontrado en {source}', lookupFailed: 'la búsqueda falló, inténtalo otra vez', noMatch: 'sin coincidencia en catálogo', edited: 'editado por ti', fullFrom: 'canción completa de {source}',
    artwork: 'carátula', lyrics: 'letra', syncedLyrics: 'letra sincronizada', levelled: 'nivelado {db} dB',
    download: 'Descargar', downloadAll: 'Descargar todo', remove: 'Quitar', play: 'Reproducir', pause: 'Pausar', volume: 'Volumen', mute: 'Silenciar', unmute: 'Activar sonido', edit: 'Editar etiquetas', lrc: 'Archivo de letra (.lrc)',
    inQueue: 'En la cola…', looking: 'Mirando tu enlace…',
    expiry: 'Te espera {n} minutos más.', expirySoon: 'A punto de borrarse. Descárgalo ya.',
    meter: '{used} de {quota} GB en espera',
    toastPlaylist: 'Tu lista está en camino.', toastSong: 'Tu canción está en camino.',
    needLink: 'Pega un enlace o escribe el nombre de una canción.',
    searching: 'Buscando…', noResults: 'No he encontrado nada. Prueba con otras palabras.', pick: 'Elige la que buscas:', close: 'Cerrar',
    tooManyLinks: 'Son más de {n} enlaces. Pega menos de una vez.',
    fineprint: 'Los archivos terminados te esperan {min} minutos y se borran del servidor en cuanto los descargas. Puedes tener hasta {gb} GB en espera; al descargar, el espacio vuelve a ser tuyo.',
    sitesNote: 'Funciona con enlaces de {sites}.',
    noServer: 'Ahora mismo no llego al servidor. Recarga en un momento.', missingTools: 'Al servidor le falta yt-dlp o ffmpeg, así que las descargas aún no funcionan.',
    reading: 'Leyendo {name}…', embeddedArt: 'Carátula incrustada',
    secAudio: 'Audio', secTags: 'Etiquetas', secRaw: '{type} sin procesar',
    container: 'Contenedor', codec: 'Códec', lossless: 'Sin pérdida', yes: 'sí', no: 'no', sampleRate: 'Frecuencia de muestreo', bitDepth: 'Profundidad de bits',
    channels: 'Canales', bitrate: 'Tasa de bits', duration: 'Duración', tagFormats: 'Formatos de etiqueta', artworkRow: 'Carátula', none: 'ninguna',
    fTitle: 'Título', fArtist: 'Artista', fAlbum: 'Álbum', fAlbumArtist: 'Artista del álbum', fYear: 'Año', fTrack: 'Pista', fOf: 'de', fGenre: 'Género',
    findAgain: 'Buscar de nuevo', chooseCover: 'Elegir carátula…', coverChosen: 'Carátula nueva: {name}', save: 'Guardar', cancel: 'Cancelar',
    saving: 'Guardando…', finding: 'Buscando…', foundOn: 'Encontrado en {source}. Revisa los datos y guarda.', foundCover: 'Se usará su carátula.',
    coverTooBig: 'Esa imagen pesa más de {mb} MB.', saved: 'Guardado.',
    shared: 'Enlace recibido. Elige un formato y pulsa Traer.',
    oops: 'Algo ha salido mal. Inténtalo de nuevo.',
    srv: {
      'Lossless, compressed': 'Sin pérdida, comprimido', 'Uncompressed PCM': 'PCM sin comprimir', 'Apple Lossless (.m4a)': 'Apple Lossless (.m4a)',
      '1-bit DSF, very large files': 'DSF de 1 bit, archivos muy grandes', 'Plays everywhere': 'Suena en todas partes', 'Small files (.m4a)': 'Archivos pequeños (.m4a)',
      'Efficient, modern': 'Eficiente y moderno', 'Ogg Vorbis': 'Ogg Vorbis', 'Untouched stream, no re-encode': 'Audio intacto, sin recodificar', Original: 'Original',
      'Bit depth': 'Profundidad de bits', 'Sample rate': 'Frecuencia de muestreo', Compression: 'Compresión', 'DSD rate': 'Tasa DSD', Quality: 'Calidad', Bitrate: 'Tasa de bits',
      'Same as source': 'Igual que el original', 'Fastest, larger file': 'Más rápido, archivo mayor', Balanced: 'Equilibrado', 'Smaller file': 'Archivo menor',
      'Smallest, slowest': 'El menor, el más lento', '32-bit float': '32 bits flotante',
    },
  };

  const fr = {
    lead: "Collez un lien ou tapez le nom d'une chanson, et je vous la rends en vrai fichier de musique, avec le bon titre, la pochette et les paroles à l'intérieur.",
    placeholder: "Collez des liens ou tapez le nom d'une chanson",
    go: 'Récupérer', goSearch: 'Chercher', formatLabel: 'Format',
    optLyrics: 'Ajouter les paroles si je les trouve', optSynced: 'Préférer les paroles synchronisées (.lrc)', optNormalize: 'Égaliser le volume',
    optAuto: "Télécharger dès que c'est prêt", optAlbum: 'Traiter une playlist comme un album',
    tabMusic: 'Votre musique', tabInspect: 'Inspecter un fichier',
    emptyTitle: "C'est bien calme ici.", emptyText: 'Collez un lien à gauche et votre musique apparaîtra dès qu’elle sera prête.',
    inspectTitle: "Qu'y a-t-il dans ce fichier ?",
    inspectText: 'Déposez un fichier audio ({types}) et je lirai ses étiquettes, sa pochette et ses caractéristiques audio. Il est lu une fois puis supprimé aussitôt.',
    dropText: 'Déposez un fichier ici, ou cliquez pour en choisir un', inspectKind: "Ce type de fichier n'est pas accepté ici. Ce serveur lit {types}.", inspectBig: 'Ce fichier dépasse {mb} Mo.',
    madeBy: 'Fait avec soin par', privacy: 'Confidentialité', footNote: 'Ne téléchargez que ce que vous avez le droit de télécharger.',
    lockTitle: "C'est privé ici", lockText: 'Saisissez le mot de passe pour entrer.', unlock: 'Entrer',
    themeAria: 'Basculer entre thème clair et sombre', meterTitle: "Espace qu'occupent vos fichiers terminés sur le serveur", langAria: 'Langue',
    upLate: 'Encore debout ?', morning: 'Bonjour.', afternoon: 'Bon après-midi.', evening: 'Bonsoir.', greetTail: "Qu'est-ce qu'on écoute ?",
    queued: 'Attend son tour…', downloading: "Récupération de l'audio… {n} %", tagging: "Recherche de l'album, de la pochette et des paroles…", converting: 'Conversion et étiquetage…',
    trackError: "Celui-ci n'a pas fonctionné.", collected: 'Téléchargé et supprimé du serveur', noArtist: 'Artiste introuvable', trackNo: 'piste {n}',
    matchedOn: 'trouvé sur {source}', lookupFailed: 'recherche échouée, réessayez', noMatch: 'aucune correspondance au catalogue', edited: 'modifié par vous', fullFrom: 'titre complet depuis {source}',
    artwork: 'pochette', lyrics: 'paroles', syncedLyrics: 'paroles synchronisées', levelled: 'nivelé {db} dB',
    download: 'Télécharger', downloadAll: 'Tout télécharger', remove: 'Retirer', play: 'Lire', pause: 'Pause', volume: 'Volume', mute: 'Couper le son', unmute: 'Rétablir le son', edit: 'Modifier les étiquettes', lrc: 'Fichier de paroles (.lrc)',
    inQueue: "Dans la file d'attente…", looking: 'Je regarde votre lien…',
    expiry: 'Vous attend encore {n} minutes.', expirySoon: "Bientôt effacé. Récupérez-le maintenant.",
    meter: '{used} sur {quota} Go en attente',
    toastPlaylist: 'Votre playlist arrive.', toastSong: 'Votre chanson arrive.',
    needLink: "Collez d'abord un lien ou tapez le nom d'une chanson.",
    searching: 'Recherche…', noResults: "Rien trouvé. Essayez d'autres mots.", pick: 'Choisissez la bonne :', close: 'Fermer',
    tooManyLinks: "Cela fait plus de {n} liens. Collez-en moins à la fois.",
    fineprint: "Les fichiers terminés vous attendent {min} minutes et sont supprimés du serveur dès que vous les téléchargez. Vous pouvez avoir jusqu'à {gb} Go en attente ; téléchargez et l'espace est de nouveau à vous.",
    sitesNote: 'Fonctionne avec les liens {sites}.',
    noServer: "Je n'arrive pas à joindre le serveur. Rechargez dans un instant.", missingTools: 'Il manque yt-dlp ou ffmpeg sur le serveur : les téléchargements ne marcheront pas encore.',
    reading: 'Lecture de {name}…', embeddedArt: 'Pochette intégrée',
    secAudio: 'Audio', secTags: 'Étiquettes', secRaw: '{type} brut',
    container: 'Conteneur', codec: 'Codec', lossless: 'Sans perte', yes: 'oui', no: 'non', sampleRate: "Fréquence d'échantillonnage", bitDepth: 'Profondeur de bits',
    channels: 'Canaux', bitrate: 'Débit', duration: 'Durée', tagFormats: "Formats d'étiquettes", artworkRow: 'Pochette', none: 'aucune',
    fTitle: 'Titre', fArtist: 'Artiste', fAlbum: 'Album', fAlbumArtist: "Artiste de l'album", fYear: 'Année', fTrack: 'Piste', fOf: 'sur', fGenre: 'Genre',
    findAgain: 'Rechercher à nouveau', chooseCover: 'Choisir une pochette…', coverChosen: 'Nouvelle pochette : {name}', save: 'Enregistrer', cancel: 'Annuler',
    saving: 'Enregistrement…', finding: 'Recherche…', foundOn: 'Trouvé sur {source}. Vérifiez les détails, puis enregistrez.', foundCover: 'Sa pochette sera utilisée.',
    coverTooBig: 'Cette image dépasse {mb} Mo.', saved: 'Enregistré.',
    shared: 'Lien reçu. Choisissez un format et appuyez sur Récupérer.',
    oops: "Quelque chose s'est mal passé. Réessayez.",
    srv: {
      'Lossless, compressed': 'Sans perte, compressé', 'Uncompressed PCM': 'PCM non compressé', '1-bit DSF, very large files': 'DSF 1 bit, fichiers très volumineux',
      'Plays everywhere': 'Lisible partout', 'Small files (.m4a)': 'Petits fichiers (.m4a)', 'Efficient, modern': 'Efficace et moderne',
      'Untouched stream, no re-encode': 'Flux intact, sans réencodage', Original: 'Original',
      'Bit depth': 'Profondeur de bits', 'Sample rate': "Fréquence d'échantillonnage", Compression: 'Compression', 'DSD rate': 'Débit DSD', Quality: 'Qualité', Bitrate: 'Débit',
      'Same as source': 'Comme la source', 'Fastest, larger file': 'Le plus rapide, fichier plus gros', Balanced: 'Équilibré', 'Smaller file': 'Fichier plus petit',
      'Smallest, slowest': 'Le plus petit, le plus lent', '32-bit float': '32 bits flottant',
    },
  };

  const de = {
    lead: 'Füge einen Link ein oder tippe einen Songnamen, und ich bringe ihn als ordentliche Musikdatei zurück, mit richtigem Titel, Cover und Songtext.',
    placeholder: 'Links einfügen oder Songnamen eingeben',
    go: 'Holen', goSearch: 'Suchen', formatLabel: 'Format',
    optLyrics: 'Songtext hinzufügen, wenn ich ihn finde', optSynced: 'Zeitsynchronen Songtext bevorzugen (.lrc)', optNormalize: 'Lautstärke angleichen',
    optAuto: 'Herunterladen, sobald es fertig ist', optAlbum: 'Playlist als ein Album behandeln',
    tabMusic: 'Deine Musik', tabInspect: 'Datei untersuchen',
    emptyTitle: 'Ganz schön still hier.', emptyText: 'Füge links einen Link ein, und deine Musik erscheint, sobald sie fertig ist.',
    inspectTitle: 'Was steckt in dieser Datei?',
    inspectText: 'Zieh eine Audiodatei hierher ({types}), und ich lese ihre Tags, ihr Cover und ihre Audiodaten. Sie wird einmal gelesen und sofort gelöscht.',
    dropText: 'Datei hier ablegen oder klicken, um eine auszuwählen', inspectKind: 'Diese Art von Datei wird hier nicht angenommen. Dieser Server liest {types}.', inspectBig: 'Diese Datei ist größer als {mb} MB.',
    madeBy: 'Mit Sorgfalt gemacht von', privacy: 'Datenschutz', footNote: 'Lade nur herunter, wozu du das Recht hast.',
    lockTitle: 'Das hier ist privat', lockText: 'Gib das Passwort ein, um hereinzukommen.', unlock: 'Entsperren',
    themeAria: 'Zwischen hellem und dunklem Design wechseln', meterTitle: 'Platz, den deine fertigen Dateien auf dem Server belegen', langAria: 'Sprache',
    upLate: 'Noch wach?', morning: 'Guten Morgen.', afternoon: 'Guten Tag.', evening: 'Guten Abend.', greetTail: 'Was hören wir?',
    queued: 'Wartet, bis es dran ist…', downloading: 'Audio wird geholt… {n} %', tagging: 'Album, Cover und Songtext werden gesucht…', converting: 'Wird umgewandelt und getaggt…',
    trackError: 'Das hat nicht geklappt.', collected: 'Heruntergeladen und vom Server gelöscht', noArtist: 'Kein Interpret gefunden', trackNo: 'Titel {n}',
    matchedOn: 'gefunden bei {source}', lookupFailed: 'Suche fehlgeschlagen, nochmal versuchen', noMatch: 'kein Katalogtreffer', edited: 'von dir bearbeitet', fullFrom: 'ganzer Song von {source}',
    artwork: 'Cover', lyrics: 'Songtext', syncedLyrics: 'synchroner Songtext', levelled: 'angeglichen {db} dB',
    download: 'Herunterladen', downloadAll: 'Alle herunterladen', remove: 'Entfernen', play: 'Abspielen', pause: 'Pause', volume: 'Lautstärke', mute: 'Stumm schalten', unmute: 'Ton einschalten', edit: 'Tags bearbeiten', lrc: 'Songtext-Datei (.lrc)',
    inQueue: 'In der Warteschlange…', looking: 'Ich sehe mir deinen Link an…',
    expiry: 'Wartet noch {n} Minuten auf dich.', expirySoon: 'Wird gleich gelöscht. Hol es dir jetzt.',
    meter: '{used} von {quota} GB warten',
    toastPlaylist: 'Deine Playlist ist unterwegs.', toastSong: 'Dein Song ist unterwegs.',
    needLink: 'Füge zuerst einen Link ein oder tippe einen Songnamen.',
    searching: 'Suche…', noResults: 'Dazu habe ich nichts gefunden. Versuch andere Wörter.', pick: 'Wähle den richtigen:', close: 'Schließen',
    tooManyLinks: 'Das sind mehr als {n} Links. Füge weniger auf einmal ein.',
    fineprint: 'Fertige Dateien warten {min} Minuten auf dich und werden vom Server gelöscht, sobald du sie herunterlädst. Bis zu {gb} GB können gleichzeitig warten; nach dem Herunterladen ist der Platz wieder frei.',
    sitesNote: 'Funktioniert mit Links von {sites}.',
    noServer: 'Ich erreiche den Server gerade nicht. Lade gleich neu.', missingTools: 'Auf dem Server fehlt yt-dlp oder ffmpeg, Downloads funktionieren also noch nicht.',
    reading: '{name} wird gelesen…', embeddedArt: 'Eingebettetes Cover',
    secAudio: 'Audio', secTags: 'Tags', secRaw: '{type} (roh)',
    container: 'Container', codec: 'Codec', lossless: 'Verlustfrei', yes: 'ja', no: 'nein', sampleRate: 'Abtastrate', bitDepth: 'Bittiefe',
    channels: 'Kanäle', bitrate: 'Bitrate', duration: 'Dauer', tagFormats: 'Tag-Formate', artworkRow: 'Cover', none: 'keins',
    fTitle: 'Titel', fArtist: 'Interpret', fAlbum: 'Album', fAlbumArtist: 'Album-Interpret', fYear: 'Jahr', fTrack: 'Titelnr.', fOf: 'von', fGenre: 'Genre',
    findAgain: 'Nochmal suchen', chooseCover: 'Cover auswählen…', coverChosen: 'Neues Cover: {name}', save: 'Speichern', cancel: 'Abbrechen',
    saving: 'Wird gespeichert…', finding: 'Suche…', foundOn: 'Gefunden bei {source}. Prüfe die Angaben und speichere.', foundCover: 'Das Albumcover wird übernommen.',
    coverTooBig: 'Das Bild ist größer als {mb} MB.', saved: 'Gespeichert.',
    shared: 'Link erhalten. Wähle ein Format und drücke Holen.',
    oops: 'Etwas ist schiefgelaufen. Bitte versuch es noch einmal.',
    srv: {
      'Lossless, compressed': 'Verlustfrei, komprimiert', 'Uncompressed PCM': 'Unkomprimiertes PCM', '1-bit DSF, very large files': '1-Bit-DSF, sehr große Dateien',
      'Plays everywhere': 'Läuft überall', 'Small files (.m4a)': 'Kleine Dateien (.m4a)', 'Efficient, modern': 'Effizient und modern',
      'Untouched stream, no re-encode': 'Unveränderter Stream, keine Neukodierung', Original: 'Original',
      'Bit depth': 'Bittiefe', 'Sample rate': 'Abtastrate', Compression: 'Kompression', 'DSD rate': 'DSD-Rate', Quality: 'Qualität', Bitrate: 'Bitrate',
      'Same as source': 'Wie die Quelle', 'Fastest, larger file': 'Am schnellsten, größere Datei', Balanced: 'Ausgewogen', 'Smaller file': 'Kleinere Datei',
      'Smallest, slowest': 'Am kleinsten, am langsamsten', '32-bit float': '32 Bit Gleitkomma',
    },
  };

  const pt = {
    lead: 'Cole um link ou digite o nome de uma música, e eu devolvo um arquivo de música de verdade, com o título certo, a capa e a letra dentro.',
    placeholder: 'Cole links ou digite o nome de uma música',
    go: 'Buscar', goSearch: 'Procurar', formatLabel: 'Formato',
    optLyrics: 'Adicionar a letra quando eu encontrar', optSynced: 'Preferir letra sincronizada (.lrc)', optNormalize: 'Nivelar o volume',
    optAuto: 'Baixar assim que estiver pronto', optAlbum: 'Tratar uma playlist como um álbum',
    tabMusic: 'Sua música', tabInspect: 'Inspecionar um arquivo',
    emptyTitle: 'Está bem quieto por aqui.', emptyText: 'Cole um link à esquerda e sua música aparece assim que estiver pronta.',
    inspectTitle: 'O que há dentro deste arquivo?',
    inspectText: 'Solte um arquivo de áudio ({types}) e eu leio as etiquetas, a capa e os dados de áudio. Ele é lido uma vez e apagado em seguida.',
    dropText: 'Solte um arquivo aqui ou clique para escolher', inspectKind: 'Esse tipo de arquivo não é aceito aqui. Este servidor lê {types}.', inspectBig: 'Esse arquivo tem mais de {mb} MB.',
    madeBy: 'Feito com carinho por', privacy: 'Privacidade', footNote: 'Baixe apenas o que você tem direito de baixar.',
    lockTitle: 'Este aqui é privado', lockText: 'Digite a senha para entrar.', unlock: 'Entrar',
    themeAria: 'Alternar entre tema claro e escuro', meterTitle: 'Espaço que seus arquivos prontos ocupam no servidor', langAria: 'Idioma',
    upLate: 'Acordado até tarde?', morning: 'Bom dia.', afternoon: 'Boa tarde.', evening: 'Boa noite.', greetTail: 'O que vamos ouvir?',
    queued: 'Esperando a vez…', downloading: 'Buscando o áudio… {n}%', tagging: 'Procurando o álbum, a capa e a letra…', converting: 'Convertendo e etiquetando…',
    trackError: 'Esta não deu certo.', collected: 'Baixado e apagado do servidor', noArtist: 'Artista não encontrado', trackNo: 'faixa {n}',
    matchedOn: 'encontrado no {source}', lookupFailed: 'a busca falhou, tente de novo', noMatch: 'sem correspondência no catálogo', edited: 'editado por você', fullFrom: 'música completa do {source}',
    artwork: 'capa', lyrics: 'letra', syncedLyrics: 'letra sincronizada', levelled: 'nivelado {db} dB',
    download: 'Baixar', downloadAll: 'Baixar tudo', remove: 'Remover', play: 'Tocar', pause: 'Pausar', volume: 'Volume', mute: 'Silenciar', unmute: 'Ativar som', edit: 'Editar etiquetas', lrc: 'Arquivo de letra (.lrc)',
    inQueue: 'Na fila…', looking: 'Dando uma olhada no seu link…',
    expiry: 'Esperando você por mais {n} minutos.', expirySoon: 'Prestes a ser apagado. Baixe agora.',
    meter: '{used} de {quota} GB esperando',
    toastPlaylist: 'Sua playlist está a caminho.', toastSong: 'Sua música está a caminho.',
    needLink: 'Cole um link ou digite o nome de uma música primeiro.',
    searching: 'Procurando…', noResults: 'Não encontrei nada. Tente outras palavras.', pick: 'Escolha a que você quer:', close: 'Fechar',
    tooManyLinks: 'São mais de {n} links. Cole menos de cada vez.',
    fineprint: 'Os arquivos prontos esperam por você {min} minutos e são apagados do servidor assim que você os baixa. Você pode ter até {gb} GB esperando; baixe e o espaço volta a ser seu.',
    sitesNote: 'Funciona com links de {sites}.',
    noServer: 'Não consigo falar com o servidor agora. Recarregue em instantes.', missingTools: 'Falta yt-dlp ou ffmpeg no servidor, então os downloads ainda não funcionam.',
    reading: 'Lendo {name}…', embeddedArt: 'Capa embutida',
    secAudio: 'Áudio', secTags: 'Etiquetas', secRaw: '{type} bruto',
    container: 'Contêiner', codec: 'Codec', lossless: 'Sem perdas', yes: 'sim', no: 'não', sampleRate: 'Taxa de amostragem', bitDepth: 'Profundidade de bits',
    channels: 'Canais', bitrate: 'Taxa de bits', duration: 'Duração', tagFormats: 'Formatos de etiqueta', artworkRow: 'Capa', none: 'nenhuma',
    fTitle: 'Título', fArtist: 'Artista', fAlbum: 'Álbum', fAlbumArtist: 'Artista do álbum', fYear: 'Ano', fTrack: 'Faixa', fOf: 'de', fGenre: 'Gênero',
    findAgain: 'Procurar de novo', chooseCover: 'Escolher uma capa…', coverChosen: 'Capa nova: {name}', save: 'Salvar', cancel: 'Cancelar',
    saving: 'Salvando…', finding: 'Procurando…', foundOn: 'Encontrado no {source}. Confira os dados e salve.', foundCover: 'A capa do álbum será usada.',
    coverTooBig: 'Essa imagem tem mais de {mb} MB.', saved: 'Salvo.',
    shared: 'Link recebido. Escolha um formato e toque em Buscar.',
    oops: 'Algo deu errado. Tente de novo.',
    srv: {
      'Lossless, compressed': 'Sem perdas, comprimido', 'Uncompressed PCM': 'PCM sem compressão', '1-bit DSF, very large files': 'DSF de 1 bit, arquivos muito grandes',
      'Plays everywhere': 'Toca em qualquer lugar', 'Small files (.m4a)': 'Arquivos pequenos (.m4a)', 'Efficient, modern': 'Eficiente e moderno',
      'Untouched stream, no re-encode': 'Áudio intacto, sem recodificar', Original: 'Original',
      'Bit depth': 'Profundidade de bits', 'Sample rate': 'Taxa de amostragem', Compression: 'Compressão', 'DSD rate': 'Taxa DSD', Quality: 'Qualidade', Bitrate: 'Taxa de bits',
      'Same as source': 'Igual à origem', 'Fastest, larger file': 'Mais rápido, arquivo maior', Balanced: 'Equilibrado', 'Smaller file': 'Arquivo menor',
      'Smallest, slowest': 'O menor, o mais lento', '32-bit float': '32 bits flutuante',
    },
  };

  const hi = {
    lead: 'कोई लिंक चिपकाएँ या गाने का नाम लिखें, और मैं उसे सही शीर्षक, एल्बम आर्ट और बोलों के साथ एक ढंग की म्यूज़िक फ़ाइल बनाकर लौटा दूँगा।',
    placeholder: 'लिंक चिपकाएँ, या गाने का नाम लिखें',
    go: 'ले आओ', goSearch: 'खोजें', formatLabel: 'फ़ॉर्मैट',
    optLyrics: 'बोल मिलें तो जोड़ दें', optSynced: 'समय के साथ चलने वाले बोल चुनें (.lrc)', optNormalize: 'आवाज़ का स्तर बराबर करें',
    optAuto: 'तैयार होते ही डाउनलोड करें', optAlbum: 'प्लेलिस्ट को एक एल्बम मानें',
    tabMusic: 'आपका संगीत', tabInspect: 'फ़ाइल जाँचें',
    emptyTitle: 'यहाँ अभी सन्नाटा है।', emptyText: 'बाईं ओर लिंक चिपकाएँ, तैयार होते ही आपका संगीत यहाँ दिखेगा।',
    inspectTitle: 'इस फ़ाइल के अंदर क्या है?',
    inspectText: 'कोई ऑडियो फ़ाइल ({types}) यहाँ छोड़ें, मैं उसके टैग, आर्टवर्क और ऑडियो की जानकारी पढ़ दूँगा। फ़ाइल एक बार पढ़ी जाती है और तुरंत मिटा दी जाती है।',
    dropText: 'फ़ाइल यहाँ छोड़ें, या चुनने के लिए क्लिक करें', inspectKind: 'इस तरह की फ़ाइल यहाँ स्वीकार नहीं होती। यह सर्वर {types} पढ़ता है।', inspectBig: 'यह फ़ाइल {mb} MB से बड़ी है।',
    madeBy: 'प्यार से बनाया:', privacy: 'गोपनीयता', footNote: 'वही डाउनलोड करें जिसका आपको अधिकार है।',
    lockTitle: 'यह निजी है', lockText: 'अंदर आने के लिए पासवर्ड डालें।', unlock: 'खोलें',
    themeAria: 'हल्की और गहरी थीम बदलें', meterTitle: 'सर्वर पर आपकी तैयार फ़ाइलों की जगह', langAria: 'भाषा',
    upLate: 'देर तक जागे हैं?', morning: 'सुप्रभात।', afternoon: 'नमस्ते।', evening: 'शुभ संध्या।', greetTail: 'आज क्या सुनेंगे?',
    queued: 'अपनी बारी का इंतज़ार…', downloading: 'ऑडियो ला रहा हूँ… {n}%', tagging: 'एल्बम, आर्टवर्क और बोल ढूँढ रहा हूँ…', converting: 'बदल रहा हूँ और टैग लगा रहा हूँ…',
    trackError: 'यह वाला नहीं हो पाया।', collected: 'डाउनलोड हो गया और सर्वर से हटा दिया गया', noArtist: 'कलाकार नहीं मिला', trackNo: 'ट्रैक {n}',
    matchedOn: '{source} पर मिला', lookupFailed: 'खोज विफल रही, फिर कोशिश करें', noMatch: 'कैटलॉग में मेल नहीं मिला', edited: 'आपने बदला', fullFrom: 'पूरा गाना {source} से',
    artwork: 'आर्टवर्क', lyrics: 'बोल', syncedLyrics: 'समय वाले बोल', levelled: 'स्तर {db} dB',
    download: 'डाउनलोड', downloadAll: 'सब डाउनलोड करें', remove: 'हटाएँ', play: 'चलाएँ', pause: 'रोकें', volume: 'आवाज़', mute: 'आवाज़ बंद करें', unmute: 'आवाज़ चालू करें', edit: 'टैग बदलें', lrc: 'बोलों की फ़ाइल (.lrc)',
    inQueue: 'कतार में…', looking: 'आपका लिंक देख रहा हूँ…',
    expiry: '{n} मिनट और आपका इंतज़ार करेगी।', expirySoon: 'हटने ही वाली है। अभी ले लें।',
    meter: '{quota} GB में से {used} इंतज़ार में',
    toastPlaylist: 'आपकी प्लेलिस्ट आ रही है।', toastSong: 'आपका गाना आ रहा है।',
    needLink: 'पहले कोई लिंक चिपकाएँ या गाने का नाम लिखें।',
    searching: 'खोज रहा हूँ…', noResults: 'कुछ नहीं मिला। दूसरे शब्द आज़माएँ।', pick: 'सही वाला चुनें:', close: 'बंद करें',
    tooManyLinks: 'ये {n} से ज़्यादा लिंक हैं। एक बार में कम चिपकाएँ।',
    fineprint: 'तैयार फ़ाइलें {min} मिनट तक आपका इंतज़ार करती हैं और डाउनलोड होते ही सर्वर से मिट जाती हैं। एक समय में {gb} GB तक इंतज़ार में रह सकता है; डाउनलोड करें और जगह फिर आपकी।',
    sitesNote: '{sites} के लिंक चलते हैं।',
    noServer: 'अभी सर्वर तक नहीं पहुँच पा रहा। थोड़ी देर में रीफ़्रेश करें।', missingTools: 'सर्वर पर yt-dlp या ffmpeg नहीं है, इसलिए डाउनलोड अभी नहीं चलेंगे।',
    reading: '{name} पढ़ रहा हूँ…', embeddedArt: 'फ़ाइल में लगा आर्टवर्क',
    secAudio: 'ऑडियो', secTags: 'टैग', secRaw: 'कच्चा {type}',
    container: 'कंटेनर', codec: 'कोडेक', lossless: 'लॉसलेस', yes: 'हाँ', no: 'नहीं', sampleRate: 'सैंपल रेट', bitDepth: 'बिट डेप्थ',
    channels: 'चैनल', bitrate: 'बिटरेट', duration: 'अवधि', tagFormats: 'टैग फ़ॉर्मैट', artworkRow: 'आर्टवर्क', none: 'कोई नहीं',
    fTitle: 'शीर्षक', fArtist: 'कलाकार', fAlbum: 'एल्बम', fAlbumArtist: 'एल्बम कलाकार', fYear: 'वर्ष', fTrack: 'ट्रैक', fOf: 'में से', fGenre: 'शैली',
    findAgain: 'फिर से खोजें', chooseCover: 'कवर चुनें…', coverChosen: 'नया कवर: {name}', save: 'सहेजें', cancel: 'रद्द करें',
    saving: 'सहेज रहा हूँ…', finding: 'खोज रहा हूँ…', foundOn: '{source} पर मिला। जानकारी जाँचें, फिर सहेजें।', foundCover: 'उसका एल्बम आर्ट इस्तेमाल होगा।',
    coverTooBig: 'यह तस्वीर {mb} MB से बड़ी है।', saved: 'सहेज लिया।',
    shared: 'लिंक मिल गया। फ़ॉर्मैट चुनें और “ले आओ” दबाएँ।',
    oops: 'कुछ गड़बड़ हो गई। फिर कोशिश करें।',
    srv: {
      'Lossless, compressed': 'लॉसलेस, संपीड़ित', 'Uncompressed PCM': 'बिना संपीड़न PCM', '1-bit DSF, very large files': '1-बिट DSF, बहुत बड़ी फ़ाइलें',
      'Plays everywhere': 'हर जगह चलता है', 'Small files (.m4a)': 'छोटी फ़ाइलें (.m4a)', 'Efficient, modern': 'किफ़ायती, आधुनिक',
      'Untouched stream, no re-encode': 'मूल स्ट्रीम, दोबारा एन्कोड नहीं', Original: 'मूल',
      'Bit depth': 'बिट डेप्थ', 'Sample rate': 'सैंपल रेट', Compression: 'संपीड़न', 'DSD rate': 'DSD रेट', Quality: 'गुणवत्ता', Bitrate: 'बिटरेट',
      'Same as source': 'स्रोत जैसा', 'Fastest, larger file': 'सबसे तेज़, बड़ी फ़ाइल', Balanced: 'संतुलित', 'Smaller file': 'छोटी फ़ाइल',
      'Smallest, slowest': 'सबसे छोटी, सबसे धीमी', '32-bit float': '32-बिट फ़्लोट',
    },
  };

  const all = { en, es, fr, de, pt, hi };
  const names = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português', hi: 'हिन्दी' };

  let saved = null;
  try {
    saved = localStorage.getItem('lang');
  } catch {
    /* storage unavailable */
  }
  const wanted = [saved, ...(navigator.languages || [navigator.language || 'en'])].map((l) => String(l || '').slice(0, 2).toLowerCase());
  let lang = wanted.find((l) => all[l]) || 'en';

  /** A line of interface text, with {name} placeholders filled in. */
  function t(key, vars) {
    let s = all[lang][key] ?? en[key] ?? key;
    for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, () => String(v));
    return s;
  }

  /** A short label sent by the server (always English), translated when known. */
  const ts = (text) => all[lang].srv[text] || text;

  /** Fill every element that names a line: data-i18n (text), data-i18n-placeholder, -title, -aria. */
  function apply(root = document) {
    document.documentElement.lang = lang;
    root.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n)));
    root.querySelectorAll('[data-i18n-placeholder]').forEach((n) => (n.placeholder = t(n.dataset.i18nPlaceholder)));
    root.querySelectorAll('[data-i18n-title]').forEach((n) => (n.title = t(n.dataset.i18nTitle)));
    root.querySelectorAll('[data-i18n-aria]').forEach((n) => n.setAttribute('aria-label', t(n.dataset.i18nAria)));
  }

  function set(next) {
    if (!all[next]) return;
    lang = next;
    try {
      localStorage.setItem('lang', next);
    } catch {
      /* storage unavailable */
    }
    apply();
  }

  apply();
  return { t, ts, apply, set, names, get lang() { return lang; } };
})();
