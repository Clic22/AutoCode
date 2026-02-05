# Idées de Fonctionnalités AutoCode

---

## 1. Configuration Discord sur Supabase

**Résumé:** Migrer la configuration Discord (Channel IDs, Approval Emoji, Private Channel IDs) depuis le fichier .env vers Supabase, tout en conservant les tokens sensibles dans .env.

**Prompt original:**
> Ce que j'aimerais, c'est le premier point, mettre aussi toute la configuration Discord, non pas dans le .env, mais plutôt sur Supabase. C'est à dire les Discord Channel ID, les Approval Emoji, les Private Channel IDs aussi, mais par contre tout ce qui est token, on ne le met pas sur Supabase.

---

## 2. Notifications de Statut sur Discord

**Résumé:** Envoyer des messages de statut dans la conversation Discord associée au développement pour informer de l'avancement : début d'implémentation, passage en review, échec de review, retry, nombre d'attempts atteint, et création de MR avec lien direct.

**Prompt original:**
> J'aimerais que maintenant le code envoie sur la conversation Discord associé au développement l'état où est-ce qu'il est. C'est-à-dire qu'au début, il va juste faire l'idéation et quand l'idéation est complète et qu'il lance en implémentation, j'aimerais recevoir par exemple le message "beginning implementation" avec les attentes et savoir s'il passe en review, si la review a fail, s'il re-tente, s'il a atteint le nombre d'attempts ou pas et s'il a créé la MR. Voilà, je voudrais avoir un message en mode "MR Created" avec le lien et comme ça je peux aller voir directement.

---

## 3. Commentaires Discord pour Modifications MR

**Résumé:** Supprimer la vérification continue des commentaires GitLab. Utiliser à la place les commentaires dans la conversation Discord associée à la MR pour déclencher des modifications sur la branche et le workspace correspondants.

**Prompt original:**
> Ce que j'aimerais c'est quand il crée la MR sur GitLab. Maintenant on ne va plus checker GitLab en continu, voir s'il y a des commentaires dessus ou pas etc. Donc ça on va supprimer le code. Par contre on va plutôt utiliser la conversation Discord qui a été créée pour s'il a déjà fait une MR, si on rajoute des commentaires dans la conversation Discord associé à cette MR, il prend en compte ce commentaire sur Discord et il va faire les modifs sur toujours la branche, le workspace etc. et pousser.

---

## 4. Choix de la Branche de Base

**Résumé:** Ajouter une étape interactive où l'agent demande sur quelle branche de base créer la nouvelle branche, permettant de développer sur release stable, beta ou autre, au lieu de toujours partir de release preview.

**Prompt original:**
> J'aimerais aussi dans la conversation avant quand l'idéation est complète et qu'il doit créer la branche à partir d'une autre branche, j'aimerais qu'il demande sur quelle branche de base il doit effectuer ça parce qu'aujourd'hui je crois dans le code c'est forcément à partir du workspace de base qui est sur la release preview, mais parfois j'ai envie de développer des choses sur la release stable ou la release beta ou une autre branche. J'aimerais qu'il y ait une étape où il demande sur la branche sur laquelle il doit se baser et à partir de là quand il copie le workspace depuis la release preview, et ensuite ce qu'il va faire c'est qu'il va changer de branche dans ce workspace.

---

## 5. Exploration des Channels Publics Discord

**Résumé:** Ajouter une fonctionnalité d'exploration continue des channels publics Discord pour identifier des sujets/bugs faciles à traiter, les proposer dans un channel dédié avec un résumé et le lien vers le thread original.

**Prompt original:**
> Ça c'est plutôt une feature qu'on va rajouter, c'est l'aspect, j'aimerais qu'il explore un peu les channels publics, un peu sur les conversations et décide d'identifier des sujets qui peuvent être pris assez facilement, soit des bugs etc. et qui me mettent ça dans un autre channel sur proposition de sujets. Et qui me donne un peu une liste de, "j'ai vu ce thread là, il a l'air d'être assez simple, ça n'a pas l'air très complexe pour l'intégrer dans le code" et donc me mettre le lien sur le Discord, le thread, comme ça après je peux aller lire le thread, il faudrait juste qu'il me passe un petit résumé et moi après j'irai lire le thread et après je verrai si j'accepte tout pareil. Donc en fait j'aimerais avoir aussi une phase d'exploration qui se fait un peu en continu et qui me propose des sujets qui ne sont pas encore traités.

---

## 6. Cleanup Automatique des Workspaces

**Résumé:** Nettoyer automatiquement les workspaces lorsqu'une MR est mergée ou qu'un sujet Discord est supprimé, pour éviter l'accumulation.

**Prompt original:**
> J'aimerais aussi que tu cleans les Workspace quand tu vois que la MR a été merge, quand peut-être un sujet sur Discord a été supprimé. Tout ça en bref, avoir une espèce de clean up des Workspace pour pas que ça s'accumule.

---

## 7. Développement Multi-Agents avec Vote

**Résumé:** Pour une même fonctionnalité, lancer 3 agents/workspaces en parallèle. Un agent évaluateur compare ensuite les 3 implémentations et sélectionne le meilleur travail, en s'inspirant des systèmes critiques à vote majoritaire. L'évaluateur peut combiner des éléments de plusieurs implémentations tout en garantissant la cohérence et l'absence de problèmes de compilation.

**Prompt original:**
> Pour la robustesse du développement, ce que j'aimerais c'est qu'au lieu d'implémenter qu'une seule fois une idée dans un workspace, pourquoi pas pour une idée avoir trois workspace, trois agents qui développent la même feature et ensuite quand les trois ont terminé, il y a un autre agent qui commence à regarder le code des trois et décider de comparer un peu ce qu'ils ont fait et de faire un peu comme dans les systèmes critiques à vote, c'est-à-dire que s'il y en a deux sur les trois qui ont fait la même chose, pourquoi pas récupérer ça ? Pour le fait que l'autre fait le travail, il faut qu'il évalue le travail des trois et qu'il prenne le meilleur travail. Attention, il faut aussi que s'il prend des bouts chez l'un chez l'autre, il faut que ça soit cohérent, il n'y ait pas de problème de compilation, il faut que la logique soit bonne, c'est quand même un gros travail et à voir si c'est vraiment faisable.

---

## 8. Exploration du Code pendant l'Idéation

**Résumé:** Pendant la phase d'idéation, l'agent doit également parcourir et lire le code du workspace (en plus de la conversation Discord) pour comprendre la structure, l'architecture, la complexité et la faisabilité. Cela permet des échanges plus riches où l'utilisateur peut référencer des fichiers/classes spécifiques et l'agent peut poser des questions contextuelles sur le code existant. Important : à cette phase, l'agent lit le code mais n'écrit rien.

**Prompt original:**
> J'ai l'impression dans le code qu'il ne regarde pas le workspace sur le code réel parce que ce que j'aimerais, c'est que certes, il prenne la conversation. Donc il voit la faisabilité et tout, etc. Et quand il va poser des questions et quand il va réfléchir, au lieu de juste se baser sur le Stratiscord, il faut aussi qu'il regarde le code. Et donc pour ça, il faut qu'il lise le workspace. Dans cette phase-là, il écrit zéro code. Il lit juste le code pour voir la structure, l'architecture, la complexité, la faisabilité et de voir à peu près commencer à comprendre comment le code est structuré et les classes. Comme ça, ça va aussi permettre, moi qui connais le code, de pouvoir lui donner des classes, lui dire, par exemple, regarde tel fichier dans le code, tiens, fais ceci, fais cela et que lui, il me parle, oui, mais moi, j'ai vu ça dans tel classe, est-ce que c'est bon ou c'est pas bon, est-ce qu'il faut changer ce comportement. Voilà. Mais qui se base aussi sur le code. J'ai l'impression qu'aujourd'hui, il ne parcourt pas vraiment le code et qu'il se base vraiment que sur le Stratiscord.

**Bénéfices attendus:**
- Meilleure évaluation de la faisabilité basée sur le code réel
- Dialogue enrichi : l'utilisateur peut référencer des fichiers spécifiques ("regarde tel fichier")
- L'agent peut identifier des patterns existants, des classes à réutiliser ou à modifier
- Questions plus pertinentes de l'agent ("j'ai vu X dans la classe Y, est-ce qu'on doit modifier ce comportement ?")
- Meilleure compréhension de l'architecture avant de commencer l'implémentation

---
