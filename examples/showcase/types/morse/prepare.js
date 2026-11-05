// The card only sees the character; the code and mnemonic stay in the key until grading.
return {
  view: { letter: fields.letter, name: fields.name ?? "", prosign: !!fields.prosign },
  key: { code: fields.code, mnemonic: fields.mnemonic ?? "" },
};
