import test from 'ava';

import {
  asArray, contractingPartyName, entryFileName, isFromAyuntamiento, text,
} from '../lib/ayuntamiento.js';
import { entryFor, loadFixture } from './helpers.js';

test('asArray normaliza null, un valor y una lista', (t) => {
  t.deepEqual(asArray(undefined), []);
  t.deepEqual(asArray(null), []);
  t.deepEqual(asArray('a'), ['a']);
  t.deepEqual(asArray(['a', 'b']), ['a', 'b']);
});

test('text lee valores simples y objetos con atributos', (t) => {
  t.is(text('Hola'), 'Hola');
  t.is(text({ '#text': 'Hola', '@_languageID': 'es' }), 'Hola');
  t.is(text(7), 7);
  t.is(text(null), null);
});

test('contractingPartyName devuelve el órgano de un anuncio real', (t) => {
  const entry = loadFixture('licitaciones', '1007341-1481547245528');
  t.is(contractingPartyName(entry), 'Junta de Gobierno del Ayuntamiento de Aranda de Duero');
});

test('contractingPartyName tolera estructuras ausentes o con otra forma', (t) => {
  t.is(contractingPartyName(undefined), '');
  t.is(contractingPartyName(null), '');
  t.is(contractingPartyName({}), '');
  t.is(contractingPartyName({ 'cac-place-ext:ContractFolderStatus': {} }), '');

  const party = (value) => ({
    'cac-place-ext:ContractFolderStatus': { 'cac-place-ext:LocatedContractingParty': { 'cac:Party': value } },
  });
  // varios cac:Party y varios cac:PartyName: se usa el primero
  t.is(contractingPartyName(party([
    { 'cac:PartyName': [{ 'cbc:Name': 'Primero' }, { 'cbc:Name': 'Segundo' }] },
    { 'cac:PartyName': { 'cbc:Name': 'Otro' } },
  ])), 'Primero');
  // nombre como objeto con atributos y como número
  t.is(contractingPartyName(party({ 'cac:PartyName': { 'cbc:Name': { '#text': 'Con atributos' } } })), 'Con atributos');
  t.is(contractingPartyName(party({ 'cac:PartyName': { 'cbc:Name': 1234 } })), '1234');
});

test('isFromAyuntamiento acepta Alcaldía, Junta de Gobierno y Pleno', (t) => {
  t.true(isFromAyuntamiento(entryFor('Alcaldía del Ayuntamiento de Aranda de Duero')));
  t.true(isFromAyuntamiento(entryFor('Junta de Gobierno del Ayuntamiento de Aranda de Duero')));
  t.true(isFromAyuntamiento(entryFor('Pleno del Ayuntamiento de Aranda de Duero')));
  t.true(isFromAyuntamiento(entryFor('AYUNTAMIENTO DE ARANDA DE DUERO')));
});

test('isFromAyuntamiento acepta todos los anuncios reales de los fixtures', (t) => {
  const files = [
    ['licitaciones', '1007341-1462267141275'],
    ['licitaciones', '10196911-1662017070602'],
    ['menores', '10094109-1652862625721'],
    ['other', '11626687-1669323049770'],
  ];
  for (const [dir, name] of files) {
    t.true(isFromAyuntamiento(loadFixture(dir, name)), `${dir}/${name}`);
  }
});

test('isFromAyuntamiento rechaza otros organismos aunque mencionen Aranda de Duero', (t) => {
  t.false(isFromAyuntamiento(entryFor('Gerencia de Atención Especializada de Aranda de Duero')));
  t.false(isFromAyuntamiento(entryFor('Dirección Provincial de Educación en Burgos', { title: 'Obras en Aranda de Duero' })));
  t.false(isFromAyuntamiento(entryFor('Ayuntamiento de Roa')));
  t.false(isFromAyuntamiento(entryFor('Consorcio Ruta del Vino Ribera del Duero')));
  t.false(isFromAyuntamiento({}));
});

test('entryFileName construye <id>-<timestamp>.json', (t) => {
  const entry = loadFixture('licitaciones', '1007341-1462267141275');
  t.is(entryFileName(entry), '1007341-1462267141275.json');
  t.is(entryFileName(entryFor('X')), `999-${Date.parse('2026-01-01T10:00:00.000+01:00')}.json`);
});

test('entryFileName rechaza anuncios sin fecha o sin id válidos', (t) => {
  t.throws(() => entryFileName({ id: 'https://x/1', updated: 'no es una fecha' }), { message: /sin id o fecha/ });
  t.throws(() => entryFileName({ id: 'https://x/1' }), { message: /sin id o fecha/ });
  t.throws(() => entryFileName({ id: 'https://x/', updated: '2026-01-01T00:00:00Z' }), { message: /sin id o fecha/ });
});
