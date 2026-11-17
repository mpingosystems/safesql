#!/usr/bin/env node
// Leak guard. Fails if a tracked file (or a tracked or untracked path name)
// refers to the project's private working context: internal folder names,
// internal document names, local machine paths, and outreach contacts.
//
// The denylist is stored as HMAC-SHA256 values of normalised terms, keyed with
// a secret. The public script never spells the terms out, and without the key
// a guessed name can't be checked against the list (a plain hash could be).
//
// Matching works on tokens: text is lowercased, runs of backslashes become '/',
// and it is split into letter runs, digit runs and single punctuation
// characters. Every run of up to MAX_NGRAM tokens is keyed-hashed and looked
// up. Adjacent tokens join with nothing and tokens separated by whitespace join
// with one space, so a single-word term ("abc-def") matches only when its
// tokens touch, and a multi-word term ("first last") matches across any run of
// spaces or tabs. termKey() applies the same normalisation to a term.
//
// Key, first found wins:
//   1. LEAK_CHECK_KEY            the key itself (CI: a GitHub Actions secret)
//   2. LEAK_CHECK_KEY_FILE       path to a file holding the key
//   3. .leak-check-key-path      gitignored file in the repo root holding that path
// The key is checked against LISTS_FINGERPRINT, so a wrong key fails instead of
// silently matching nothing. With no key the check fails in CI and warns
// locally; it never passes silently.
//
// Output names the file and line, never the matched text or the key.
//
// Usage: node scripts/check-leaks.mjs [repoDir]   (default: current directory)

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// hmac(key, termKey(term)), one per denylist term.
export const TERM_HMACS = new Set([
  '0026bb129c7bf6633ce6d05734696215750a424f3f3698ac456fe2b1769f582c',
  '01b2c144f6ad6a48e7a44b5032f9b498d0ef2a696932c19627dce9988066bab0',
  '01be8f8532e391f93ce3342cc4934eb737ff5c10edc1cc1924f5ab30a3be1340',
  '06b7e3d8927ace86bc77467585ac74cdc3208ec706d1a0abc52a2d1b8138888a',
  '06f84ec0f668f647d99ee03658ab299acf2a07a58567869a52e1755668034586',
  '153c445da36364f10115422e065a94c0c1a54859c885068ab9e653f259227a1b',
  '1783d536a9b517213c10b0ce1d257e02074e8370eaa060092eccf3dc9e0decfe',
  '1851dfca6c783a499339c2d586da214ae7ab27dc83db38f8a55bce12ba15b5dc',
  '1a96775eccac080b41215f8b22471f32e69563b7cf9dae8c90f2ec2e6921f392',
  '1d68ef73b350395827cdbc2cd3087c9147a0df625b898a6c4de0872c70bb627e',
  '2186fa7afb04b232550ca30b86fd83b3a4a2dd67c64a73239fdac5ec48f6e4e5',
  '2262e3ed0ed8e9df679102c187d26f35131b94943ce324a5a196ae110d2e3a07',
  '232ebf7d7c16b2ef907880da6e470890b662a1e926e7037fd65db9425c0ea37f',
  '2727654e06c3f8c6a4608f79ea53366be20ed01f215539aa129f0d4effa9f814',
  '2bb873b9bb3e49a767a93d5ddf8237e63c2c7c8359dcd33c80a0a04ddb587b29',
  '2e91bd1fbce2b4730e43e42be56c2b298203619b1eb3ad34645becf90c6bb511',
  '30f1beb7ddc55fffe7cf95d02550431e7e7f30ded0e849a42b99f59ab8f40475',
  '33084ad14397cf063c3bfcd5ce4f07843933ab1d6273f02831134a96fce5bf14',
  '34b1b4ad0b64c205d3f1e2175aad5ba9e2d280e0015aaa945077237d293afa4c',
  '353895016ddfba6bf701a0072c2edce5793f030630a23ec341de2b6206515dde',
  '36c4ca97a3768c5707a599ad83322a71699fd5adc9e08174bd4b7c2b238f9f38',
  '3848fa6617285c4cc26eb8aad6f498a66bb7bc0267ad83b8940728c3c7136fc1',
  '384ec127fb43e069b7dbf722883c6763d75971bd5f707cbf01e4128ad6faded7',
  '38e0d66f760092db1c87b210f8bf298a5932d24ddc290e7b6669afdfdba1550e',
  '3ab3e86835da12a0afbf73e5b3ed75bca7c94cce7a8187873b4850cf7f5f6932',
  '3ca2f53a2d6c4073ed860f40821a56341176d07df8c7d0bfda5623eb38a69247',
  '3e4652a8d4cdba94ec37ffe7cc8dcd4b5b087efa6cb808e5aaa0aed0960a94ec',
  '3fbbcc516bf74b759620d4fe9bfd39f9ef430936e654a9d8126d8d16d94bf811',
  '41a336a2d8e322b1e91030059cc7ac0d26b1d3d7caaa35f2c72f0cca01e91b53',
  '429eaadae055037e8b191e4cc061c48b04e9ec2d66978c7fed5a3106649dc0a9',
  '42c45ea2baf3efd8b82ab21f673c4f5eee227113ddf05d53b8d7f3e19ab67a4b',
  '43bff08fb0dac90bc5addd8aeb7d821e3a556020c0b6fe5e3ffc6c67b6f38da3',
  '46b2cd91ccc6e152e69614b03823889cc46772ece8a7008ddbc5a3c0ebf613fc',
  '49c3c1b6411c363c48f589212dd6b9859d7ae56cbfada0c48a792f29f59aaef3',
  '4d3aded5d54d1d153f4421617acb1db182cf30318840122bb69833565f462b8b',
  '5084491cb292ac5f0f199df7d0c945711ddc1ebee5807104848949e643760faf',
  '50c12695121c188b1a8744ca42bff559f5aca4a6d38e175d002c470aa103e16c',
  '5204c82878debe1c760ca48a21a21c1890c0b8d8e1bb8b1577bdfe9a22fb8cb3',
  '5cab4a153d68803b2524f5f2364374f176eb3c9b922261cf401a74f6d2800702',
  '5cc07ddd44aab9dd012ba9cac728a9d652277a5a98fcb129c5165f99026d5520',
  '5f589cf654f138673603b29b3b4d19e8ed8270dcdc6b7fe2ee0a67246a388bc0',
  '610956af7fe47fee32b6fa2980a969ebd82896ce888fde4f0440d396f47aa7ac',
  '6396a6a0b86c442a4732717be81f0b4192d6303b9a24a29792aea755a6dd0a4a',
  '64900c6090f87cb02bc38cbb55e640bb60a77f77dca63d9e9dd664bc7af0937f',
  '6600fad1c1c275c0535b5c08d372aa426beb7f83c87d37ff4a2ffb0dfd15c9fa',
  '66ba870194593fa54c28aad174e0313c0939c865c01b98fab1791746a92b6646',
  '698fd21b147e92873b0d99891a440bb8b2cc5939a46cdbcb0bb6c3b1e40ccf68',
  '69ed655d892a14d38220a794f4054f34d16e044eef86623b4d3b4f9608144fa4',
  '6cdaa97640f5f616d08cdf3c95cb92d1ea299bb56877e8bbcd0f268f1a7fb6a2',
  '736ebe6037ad87180849d04964b710e2fa4653e44d5f3a757c00bb933fe6d8e5',
  '7ad2811c32cad552d1ca2fe73b3a7618808c0e9a78334467316b07942d56de62',
  '836590507fa415f142b233fa9fb7bef4fcf3221bbf2e28e70c7bc943d7cb5876',
  '85fb53ad3fa82ef0706dd64d9603a8604ff99bc6207e9c1756918dda14141d25',
  '8741820eb9abfe55bddc2bb16bfe35486d226ea8533a3e3d3fd7a90ee050ff53',
  '89306209cfd75d5dcf5b6eb25e928e5c45b7d9efb806abdc981e3a45dfea7a6b',
  '8f032a1f65171e9af3edd9d7c01d29419a9c38438263d5c8bb96f6468b88f785',
  '8fc09daf87db9d623cf0468ca623f118291f5f8d74e623d580f8db403778bc42',
  '908233bd5ec922a7d38b47e4256c35f39b07794d542538355691a4b3ae4043f4',
  '93aaf8426b232cfd0ea8d98a89af543993133b75f864b7feb955e5802b8e1308',
  '9501d517d1f99d0b17ab7d7ae9dffe373e8af0587a3e1ca6d010b58cf39600b9',
  '989ae77eecf6de202ddc0c566028436beaf9b0c533abaa979ab88a893e17d0c9',
  '98de29c62e72d126a8f9b5bb6f1bb35bcce6ae924b41744813da5b0915641e74',
  '9cf82852984a73e40a51e404401984c0d11db0b48a2385898b4ef68432ece47a',
  'a173979aa882989f0a50753bf6f8e6fd5bf95da00563bd62f91a4304f26d4066',
  'a1cdaa81f3a8fb880aadf14e02c4e5eee354479ddefd3794f6699ac30da2a4bd',
  'a29af7650d5c0dd9e5354d798191ee96f1b4e61bd4477bca9534838743e478aa',
  'a37e85459cfbcbc5e1faaaa6fe172c9bd1da0f746f91ecce4ffbdd109e3534a1',
  'a57216e6c77637dbf1e954e34d10b21c47c9867aaf66d844ecfb5f683afd825b',
  'a81425e05bfa9b1ba5894bb9ddb9adfe02a3f5023bf14a023777bfa2f1169f16',
  'a9f4b0ffe5735c9134692cea91b02f3c19ca6f6de3c188afb468101ad2a4d70a',
  'b221fa264338892042e16f883c4b9adde9f6684828e607528bfcd8e731384b8e',
  'b2bda3220f5d2d44ee661b8a212692aa7693254603807cf2cdeacad263af4cf5',
  'b75aa0dbe61ff79885d230d35895a6f30c2ea02f550fbf73ec8bcf60ed6ed7e7',
  'baa73ef878c64c3b3b5eaa526cc329ec3591e54c64e7b942d5a4698b4d23f735',
  'c2587b6d28cb4cc88616e8d8fca62683fe0bbbed63f17814db724c5ebfb797a0',
  'c354172d0c502f608fec62f3db276751774f5c2b836d94576617b617baa5942a',
  'c4ac5e8803e6d2ae5e462a2f5cebb5408613b625e2b56c02b5385d7463e29d74',
  'c5641968c2de87d0e9a51ce73b182d995b4c3c37c29ee63512498f7073d20c5f',
  'c67bd3716cd6d075384002c0c59e21c1d6f4473242ecfe9a211f6ebc4c4dea59',
  'c841689bac076143bc8b7bb8e094170b96af04af29d825dbbcfc3e4bc2c06da3',
  'c8719a117cdb2fefe6a93bcd40739e41215fb1b0ef41b00218afbad65f657793',
  'c9b7e7af9d03e7a1e5ed7549fa71299b8945b27fb8d122d09bba0d2a86a79f74',
  'c9d44fb6c1b80a5772f6da0a693d729cb3c8a55081f5f651f32a6e597ee428a3',
  'ce75c69723487bddea967eca69683f35853ebb1ade7723ff128d4cd426e73e70',
  'cf747e316aa36201430ba6738cdb292f644283ca2bfaf0d2cc1dfc857502faab',
  'd1fc3d06dc59470fd25ec50c1f80c3afa92fc9ceca7a2727109d9e69d2834763',
  'd4d43053fd87645f88b43d07039873bf0a527ce40edca478a1b8efbc440985e7',
  'd67f9468c5c515ba892a07cd5cd37365df1f1c8cb6960542276e6af5011c7d6d',
  'd6a75a3a2c9a5707e8d04c09a1de6abd75adc14aa4b6f62d4a4e0750466901fb',
  'd844d1ebe14cd03e8e25641f57f05b20bd04132ec423bf96237f63e6feef376f',
  'dc14170e6a6fb857dd5d82588d877db1b74bc437aab80051772f4d19dad508be',
  'de89a6cb88bd282988f232f5f603f27d33863e899af19be904fbebb11b987583',
  'df2559a30f81780ef357353c638fc401b6609430917fd2ea43f2b0fb31fab2cf',
  'e8ab3713891d22e87aa4cbf8d82ad4578df8411a21a9426d22242705a3b5a344',
  'ec751ef4bbf448456478c5e11ddb13deb15161116b4608266cf10661c18cd19a',
  'ef15eba4a14f1e4479451d6e6d862488165cf51dd6c72bfaf520ef3dff36c1f7',
  'f02cdb77e323d9b0eda40f418306da35b007935eecb3678b9d179687f063ee67',
  'f64c44246acb8f592453ee9d1885c337f3e15d3eeb2b03662e34434711347b5d',
  'f65b6507276b9a80c130b9ad361868cd5774cb48e7695568432c90dd9f48f642',
  'f6925869b27acd006b76c98e737d2d66b814d391c30c9f7748a53aa0a5b2086d',
  'fe3391aa171f150acf656d6bde38808c5ddb5fd2ece3a83476ab131a8fb9f95d',
]);

// hmac(key, first token of each term): a cheap filter so only plausible
// starts are extended into n-grams.
export const FIRST_TOKEN_HMACS = new Set([
  '0ceedefb332aecbc0d6a92d26f4a24474d35b6cf274eef83f7292ae645e74ccc',
  '0e261e37b3bd47768c503ff0c0311ba7513836d0b0e901110eb15d3a1f4b899e',
  '136a46fa0714d21b22d5dafef06ad4838d1e0c14a7bbf1d7db1e0e233d177dd8',
  '149bfa1b4b49b5a4b2a8d5a1c63f11ad01739156453d27156ec3232b541af1aa',
  '153c445da36364f10115422e065a94c0c1a54859c885068ab9e653f259227a1b',
  '1604db6e9a5672c389a6312eaf5c5c4ba7b7e95403aeb71512e43693d20abee4',
  '163c6b4f956039044682fc143ffcabeb9e9b1492e27b9b69715137c313f80716',
  '1783d536a9b517213c10b0ce1d257e02074e8370eaa060092eccf3dc9e0decfe',
  '1e438d51b3d67e2dfb137df79b7ae7c8908945753bf80ccc7dee7d4ef59af2d1',
  '2186cb22fc5d35aa25bf3d6a1a6e38500559d5e8f286bd2351518bef3c53cccf',
  '24643bdf80dbc9477d3093edf7c0a25f9b07381701a67498d66c3921daa11375',
  '26741cfec861294551648f1dbe0e4137c44f43a9c4e9bc78cfd7d698b88e174c',
  '28d49b4fbe2133377bd35f6be60ed88fa66d48da153b56aad69c7d26698b8e17',
  '29176ff2f1c2b41053ff124155bf837cc48e8775cfb451ce5335befbff42b18d',
  '29be7a71136b5102b38899d5e35998d8d4d6a42861a34903305b88aeebdf4c23',
  '2caa1d94583a938ed92652a86e7a3af47a52594ca25462ceb5f14bf11e93972e',
  '31e02966bfd01781ba6cf710646cb21e639ea1b44ff8f893c096314454dacc07',
  '33084ad14397cf063c3bfcd5ce4f07843933ab1d6273f02831134a96fce5bf14',
  '3351cc626acc170c9b666c2ab255d6d2b3aebbcd91af5930d73700ab1e934a2c',
  '370e3c1329747352b0db463b7fb6b3b4f52e1d75c11750a8623312dcc3d95490',
  '40aa1ac931a88bfe0ae08540c5124f575a3e1ce07c9b4953704e71d94252039c',
  '419d43571a72af3e30e1cc0e8e4b36ac738437d8800bbb796a7998e17f53ce4b',
  '428c92a43a2615fa0523ce093e456d62fc665cb06f5dbd1b5e1f253b16b2cc5a',
  '468932344cba388f5c47e839fbdd06600e397f55246272d073a4afc94acc4087',
  '46b2cd91ccc6e152e69614b03823889cc46772ece8a7008ddbc5a3c0ebf613fc',
  '49c2e4c0d2cc14e7f70cfa87d8b900f77e7c641e78efa9de5872458208ebc05a',
  '4d3aded5d54d1d153f4421617acb1db182cf30318840122bb69833565f462b8b',
  '550b39daba9c32801a2602104ec5f59f4360286909beae9b1f18c7c36b84e64c',
  '5aee17ae928fbe5236149fa3c4f40b8de8fdbf01da0e396dae90df6ed8da962e',
  '5d500db5796b0011fd1da62078f5c4a034c2fc293716e5d1e0e761e1026007cf',
  '5ef09c37596b727879b91b94135357de32e5967544485007eb173185cf2d8d98',
  '5f8aca7cb689c0b572b664184924e53b7b664a9f5e47494defe36e72a8a42547',
  '60511fb4b2640428950c85070b9f62b87b21956a8581447e855f6ccc13722fec',
  '60a89de37dbd15c661910a21e73c2bfe6ab954097b4dc49499d3c0cfcd6522e7',
  '62903d5c170dcc6ec958bfd678ffb263e62f6c599c4cad916c9f1cf69cb6282d',
  '648ccc231ad0a990327b6af134ba4f0c22eb0d886413239134d5afe71923db9f',
  '6cacc4021e8a1ffc90e0d823ab5f73f589e9a86d8121c81b4c2c77963a2d6960',
  '6cb90aa65cf89115b42b990e9f0a3c1c2a4aac211b8e0bff9a0782bc68e70176',
  '71a529490f1f9b3b9a3b94daae28e317c6577352ae0d4afa4d9be6cbe8daa875',
  '75e72378227bd9fe94c2fb6ac7e5b4701dcca7ee713d24aaabc6e5cc8b4758d7',
  '779c0af90fc911e711be6e6810b3962cdd095737bccfebb35bf81be98d69d3ae',
  '813bfdf404d8032d2b277a265e2e7a80313050c99498c4d0941f4a89198438bf',
  '838f0329ef623227f1d41f7b4db1397eca6e34f0e01ad9b2b92b65f2ed064bd4',
  '8743186480cd03435981aae1ddc57a5dfa060bc5048e12d0e080722cc4e57605',
  '89306209cfd75d5dcf5b6eb25e928e5c45b7d9efb806abdc981e3a45dfea7a6b',
  '89f7ae6e4326ee1e7930d5797f7461f0990eaf2224fe588f5d01a007e9873783',
  '8cc5b0aaf9b73cfd837a21e7624726dba1455f4010bb4732b66110e885f2eb25',
  '8e53808c960a381777d5e97375e5f58cc7806c52bb7e84cec90335b8634518af',
  '8eb4681e1f074486d5093906411ae84e45394e42150c68dc78e75859614e9af9',
  '8f032a1f65171e9af3edd9d7c01d29419a9c38438263d5c8bb96f6468b88f785',
  '9ab587a1f7538327b54be981964791f77111b688eb7ec4d9b713b17dfa95b6b4',
  '9ccf6eb3da0c04089224d0d679abcf19335d460ba4a2e2e3a734e0edb79e6ce9',
  '9f1df5ef5513ccf5bd73ca752d8f583e0c9b77088d90cad3bbd3758baf405ec7',
  'a183d4420833d766aae437b3ab2ffd2b03658913214e752e61ed2d0f5201cf8f',
  'a19e8b1cdca888dcd2e4b608bd8662b637c724801c76ce17608526a8df571230',
  'a7c948b48e069673129b5f297ada422ed907a36ea9b7e429ca0a15a8b21323b5',
  'aa09bb08d4c29877b3ea0378d0f09c1483665c1091c2a070310cdc8348cc2e04',
  'ad7bd11829cd48a61877e9393e39076f133c28619ac339bafcd1c4d966259576',
  'b1f72cf6ce1f37e0989a0531045dee4aa9d169f9bcc25034f04668d9d96ff4c8',
  'b2fe0b880771c88cb9b80caa6e1de01f6876dbaecc263d30669129869278fe9a',
  'b898404dbf2af6739dab1bbcf70fd6570e2493ccec64f38716d3c9da81dd3ee0',
  'bd8875e0be176dc48ba971e016130a0c09d2386e447754264ea7fe259f217fea',
  'c119579097a2774de633a80b0357354b19329072f8f2c176ab03a5000675586f',
  'c40361d37855ff1d07f52414fd613ee57b90d23d85d182b73318afe8b6330a1c',
  'c4ac5e8803e6d2ae5e462a2f5cebb5408613b625e2b56c02b5385d7463e29d74',
  'c8c66a6adf8948b406f76b637d15f0ac7d14e2e1d1b39eaba1bcc1338de589d0',
  'cc875e9181e04f67e0c9f9b13273287201cfbc8dd881cd8a4767e07d8b497990',
  'ce2a6189b69100aafcf8edd4fcfc2a9b206ef3c29dff3674a0ee48d95d4e56fa',
  'cf747e316aa36201430ba6738cdb292f644283ca2bfaf0d2cc1dfc857502faab',
  'd254552ca240e1b45f31e46a6abaf292a349ef0d88b2467aedb2c102a706dc81',
  'd37c282689b93ab6b1457c0fe75ab288aa563657b98efc4f30c40a1ac4fd3e36',
  'd819062af671c8ecbd6f52cffb78434779c712117b167596a91d6ea651bc79a5',
  'd844d1ebe14cd03e8e25641f57f05b20bd04132ec423bf96237f63e6feef376f',
  'd9fb7274e65b2c435c0f4dd2bff6b33ff7110abf14a7d1726d568cf7b19cf8cf',
  'dbb57cea791d0c0a4bb7c35467afa453f269a7963025cac1b7413a9972f6dd54',
  'df7e39a5459095785940bfdf58398cca7b4d4a4eb01a12de38ab643d4f05ff68',
  'e07829cbb2e373981af4a3d5bcff09214e5c988f51a8101a93917a409223a747',
  'e21e1fd2c5e8723e16c0642b7a1b48ea20ed1ec91a3a3290599b065e7fd59551',
  'e52c4b6a51943a08d7952e1da14e50aabd41065f91110b1e52db0ac21de07cbc',
  'e6731917d45429a91c77c521674fb53ff7ce1b717f902eca04dfb427b1478218',
  'e82c7deeea4e5f045aee938ef34b6a3103afb6c310e9ab7166ecc46293e9084e',
  'ee118236e8498ad1d0ed4e3b3445f191fac416c8d06c6333dca8a6210d156b5b',
  'f059aa3beca66bd64734ca8974e9650e7d0405c7c9cc2dbf31d5ef64eca9eebe',
  'f2e9ba62ea2239fe974e544b966a3487c6652c3aaed2be2d881c01a10759090f',
  'f46fbce520c8bf14397c918b13cbc9749bbe284fff2bfe67c4366167501ef1fd',
  'f7f259994d693f83ab12ba489a488339869a939c38e6c82a3cc8834b98cfb0c4',
  'fe2bba10b69225b9c4a5c249a0b6101297449a9bf47ab125acbe3e8b7b10f151',
  'fed2665197783dc30505216f9461022ba08f2ad9364c1825ecf4fe29e52e068e',
]);

// hmac(key, FINGERPRINT_LABEL): proves the loaded key is the one the lists use.
const LISTS_FINGERPRINT = '25fb528db5d4e8a24ed682e5f477db5e0ab233ae594eeffde8704c54f12e1936';
const FINGERPRINT_LABEL = 'safesql-leak-check:key-fingerprint:v1';

const MAX_NGRAM = 16;
const TOKEN_RE = /[a-z]+|[0-9]+|[^a-z0-9\s]/g;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const keyedHash = (key, s) => createHmac('sha256', key).update(s).digest('hex');
export const keyFingerprint = (key) => keyedHash(key, FINGERPRINT_LABEL);

export function normalise(text) {
  return text.toLowerCase().replace(/\\+/g, '/');
}

function tokens(text) {
  return [...normalise(text).matchAll(TOKEN_RE)].map((m) => ({ t: m[0], start: m.index, end: m.index + m[0].length }));
}

// The string a term is hashed as: its tokens, joined the way the matcher joins them.
export function termKey(term) {
  const toks = tokens(term.trim());
  let key = '';
  toks.forEach((tok, i) => {
    key += (i > 0 && tok.start !== toks[i - 1].end ? ' ' : '') + tok.t;
  });
  return key;
}

// Finds the key. Returns { key, source } or { key: null, reason }. Never logs the key.
export function loadKey(env = process.env, root = REPO_ROOT) {
  if (env.LEAK_CHECK_KEY && env.LEAK_CHECK_KEY.trim()) return { key: env.LEAK_CHECK_KEY.trim(), source: 'LEAK_CHECK_KEY' };
  let file = env.LEAK_CHECK_KEY_FILE && env.LEAK_CHECK_KEY_FILE.trim();
  let source = 'LEAK_CHECK_KEY_FILE';
  if (!file) {
    const cfg = join(root, '.leak-check-key-path');
    if (!existsSync(cfg)) return { key: null, reason: 'no LEAK_CHECK_KEY, LEAK_CHECK_KEY_FILE or .leak-check-key-path' };
    file = readFileSync(cfg, 'utf8').trim();
    source = '.leak-check-key-path';
  }
  if (!file || !existsSync(file)) return { key: null, reason: `the key file named by ${source} does not exist` };
  const key = readFileSync(file, 'utf8').trim();
  return key ? { key, source } : { key: null, reason: `the key file named by ${source} is empty` };
}

export function keyMatchesLists(key) {
  return keyFingerprint(key) === LISTS_FINGERPRINT;
}

// Returns a line matcher for the given keyed-hash sets (tests use their own sets and key).
export function createMatcher(termHmacs, firstTokenHmacs, key) {
  const h = (s) => keyedHash(key, s);
  const firstCache = new Map();
  const isFirstToken = (tok) => {
    let hit = firstCache.get(tok);
    if (hit === undefined) {
      hit = firstTokenHmacs.has(h(tok));
      firstCache.set(tok, hit);
    }
    return hit;
  };
  return (line) => {
    const toks = tokens(line);
    for (let i = 0; i < toks.length; i++) {
      if (!isFirstToken(toks[i].t)) continue;
      let gram = toks[i].t;
      if (termHmacs.has(h(gram))) return true;
      for (let j = i + 1; j < toks.length && j - i < MAX_NGRAM; j++) {
        gram += (toks[j].start === toks[j - 1].end ? '' : ' ') + toks[j].t;
        if (termHmacs.has(h(gram))) return true;
      }
    }
    return false;
  };
}

// The matcher for the shipped denylist.
export const denylistMatcher = (key) => createMatcher(TERM_HMACS, FIRST_TOKEN_HMACS, key);

// Returns line numbers (1-based) that contain a term.
export function scanText(text, match) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (match(lines[i])) hits.push(i + 1);
  return hits;
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Returns { files, findings: [{ file, line, kind }] }. Never returns matched text.
// kind: 'content' (a line in a tracked file) or 'path' (a tracked or
// untracked-not-ignored path name, which also catches a private working-context
// folder created inside the repo).
export function scanRepo(dir, match) {
  const root = resolve(dir);
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const findings = [];
  for (const p of [...tracked, ...untracked]) {
    if (match(p)) findings.push({ file: p, line: 0, kind: 'path' });
  }
  for (const f of tracked) {
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    for (const line of scanText(buf.toString('utf8'), match)) findings.push({ file: f, line, kind: 'content' });
  }
  return { files: tracked.length, findings };
}

export function formatReport({ files, findings }) {
  const out = findings.map((f) =>
    f.kind === 'path' ? `  ${f.file}: path names private working context` : `  ${f.file}:${f.line}: refers to private working context`,
  );
  out.push(`leak check: ${files} files, ${findings.length} findings`);
  return out.join('\n');
}

const inCI = (env) => env.CI === 'true' || env.GITHUB_ACTIONS === 'true';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadKey();
  if (!loaded.key) {
    if (inCI(process.env)) {
      console.error(`leak check: FAILED: no key (${loaded.reason}). Set the LEAK_CHECK_KEY secret for this job.`);
      process.exit(2);
    }
    console.warn(`leak check: SKIPPED, NOT RUN: no key (${loaded.reason}). CI fails without it.`);
    process.exit(0);
  }
  if (!keyMatchesLists(loaded.key)) {
    console.error(`leak check: FAILED: the key from ${loaded.source} does not match the denylist (fingerprint mismatch).`);
    process.exit(2);
  }
  const result = scanRepo(process.argv[2] ?? process.cwd(), denylistMatcher(loaded.key));
  const report = formatReport(result);
  if (result.findings.length) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}
