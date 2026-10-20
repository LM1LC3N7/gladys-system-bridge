# System Bridge

Suivez un PC Windows ou Linux depuis Gladys grâce à
[System Bridge](https://system-bridge.timmo.dev), une application libre et
gratuite qui tourne sur le PC : s'il est allumé, charge du CPU et de la
mémoire, occupation des disques, GPU, batterie, utilisateurs connectés, durée
de fonctionnement, caméra et micro utilisés ; et des boutons pour le
verrouiller, le mettre en veille ou en hibernation, le redémarrer, l'éteindre,
ou ouvrir une page dans son navigateur.

**Intégration non officielle, sans lien avec System Bridge. Elle n'a jamais été
testée avec un vrai PC : merci de signaler ce que vous voyez.**

## Installation

1. Installez System Bridge sur le PC (Windows ou Linux) et lancez-le. Il écoute
   sur le port **9170** ; laissez-le passer dans le pare-feu du PC pour votre
   réseau local seulement.
2. Dans les réglages de System Bridge, copiez le **jeton d'API**.
3. Dans Gladys, ouvrez cette intégration et remplissez :
   - **Adresse du PC** : son adresse IP ou son nom, ex. `192.168.1.20`
     (ajoutez `:port` si vous avez changé 9170). Donnez au PC une adresse fixe
     dans votre box.
   - **Jeton** : le jeton copié plus haut. Il est gardé par Gladys dans sa
     base, jamais réaffiché, envoyé seulement à System Bridge, et jamais écrit
     dans les journaux.
4. Appuyez sur **Tester la connexion**, puis ouvrez l'onglet **Découverte** et
   ajoutez le PC.

System Bridge n'a pas de https : le jeton et les mesures traversent votre
réseau en clair. Utilisez-le seulement sur un réseau domestique de confiance,
jamais par Internet.

## Ce que vous obtenez

Un appareil par PC, nommé d'après le PC et identifié par son identifiant de
machine (il survit à un changement de nom ou d'adresse IP) :

| Fonction                                                 | Signification                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Online                                                   | 1 tant que le PC répond, 0 s'il est éteint, en veille ou absent              |
| CPU (%), CPU                                             | charge, et température quand le PC la donne                                  |
| Memory (%), Memory used                                  | charge, et Mo utilisés                                                       |
| Disk … (%)                                               | occupation de chaque disque (12 au plus) ; les montages système sont ignorés |
| GPU (%), température du GPU                              | par carte graphique (4 au plus), si fournies                                 |
| Battery, Charging                                        | portables seulement                                                          |
| Power                                                    | si System Bridge la fournit                                                  |
| Users logged in, Uptime                                  | sessions ouvertes, heures depuis le dernier démarrage                        |
| Camera in use, Microphone in use                         | 1 tant qu'une application les utilise                                        |
| Restart pending, System Bridge update available          | si fournis                                                                   |
| Lock, Sleep, Hibernate, Restart, Shut down, Open the URL | boutons                                                                      |

Un disque ou un GPU vu une fois reste sur l'appareil (sans valeur tant qu'il
est absent), pour ne jamais perdre son historique. Sous Windows, seules les
cartes NVIDIA donnent une température de GPU (pour les autres, Windows donne
une zone de la carte mère, pas celle de la carte graphique).

Le PC est lu au rythme choisi dans **Rafraîchissement** (toutes les minutes par
défaut). Quand il ne répond pas, Gladys réessaie 30 secondes à 5 minutes plus
tard, jamais plus vite que ce rythme. Le bouton Découverte montre la dernière
lecture quand elle est plus récente que ce rythme.

## Boutons et sécurité

- **Verrouiller** (Lock) verrouille la session ; il est toujours permis (il
  protège le PC), mais seulement tant que Gladys est connecté à ce PC (il
  n'ouvre jamais de connexion à lui seul, il est donc refusé quand System
  Bridge a demandé à Gladys de ralentir).
- **Veille, Hibernation, Redémarrer, Éteindre** sont refusés tant que vous ne
  cochez pas **Autoriser la veille, l'hibernation, le redémarrage et l'arrêt**.
  Le travail non enregistré sur le PC est perdu au redémarrage ou à l'arrêt. Ne
  les autorisez jamais sur le PC qui fait tourner Gladys.
- **Ouvrir l'URL** est refusé tant que vous ne cochez pas **Autoriser
  l'ouverture de l'URL** et ne saisissez pas une adresse http ou https : elle
  ouvre cette page dans le navigateur par défaut du PC. Jamais un fichier, un
  chemin ni un programme.
- Ce sont des boutons, jamais des interrupteurs : ni assistant vocal ni scène
  « tout éteindre » ne les atteint. Dans une scène, utilisez l'action « changer
  la valeur d'un appareil » sur le bouton.
- Avant une veille, un redémarrage, un arrêt ou une URL, Gladys relit le PC et
  vérifie que c'est la même machine. Si cette vérification ne tient pas dans
  les 5 secondes de Gladys, rien n'est envoyé. Une fois envoyée, si System
  Bridge ne confirme pas à temps, Gladys dit « envoyée, sans confirmation »
  (elle a pu s'exécuter).
- Gladys n'envoie **jamais** de ligne de commande, de frappe au clavier, de
  notification, de fichier ni de chemin, même si System Bridge les accepte.

## En cas de problème

- _Le PC ne répond pas_ : il est éteint, en veille, System Bridge n'est pas
  lancé, ou le pare-feu bloque le port 9170.
- _System Bridge a refusé le jeton_ : recopiez le jeton depuis les réglages de
  System Bridge et enregistrez. Gladys ne renvoie pas seul un jeton refusé
  avant 6 heures.
- _Ne répond pas comme System Bridge_ : vérifiez le port.
- _Ralentir_ : System Bridge (ou un intermédiaire) a répondu HTTP 429 ou 503 ;
  toutes les requêtes sont suspendues (1 minute à 6 heures), même après un
  redémarrage. Le bouton de test lève la pause.

## Vie privée

L'intégration ne lit que les modules cités plus haut : jamais la liste des
processus, les médias, les connexions réseau ni les notifications. Les noms
d'utilisateurs, les applications qui utilisent la caméra, les adresses IP et
MAC ne sont jamais publiés ni journalisés.
