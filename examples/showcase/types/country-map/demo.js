if (view.face === "locate") return { pick: key.index };
return view.face === "capital" ? key.capitalChoices[0] : key.country;
