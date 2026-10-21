const norm = (s) => String(s || '').trim().toLowerCase();

// Does a kitchen deliver to the customer's city / neighbourhood?
//  - kitchen lists delivery areas  -> only those areas (the customer's area OR city must be one of them)
//  - kitchen lists none            -> its whole home city
// strict=false (browsing): a customer who typed only a city still sees kitchens in that city, so they can pick an area later.
// strict=true  (placing an order): the address must clearly fall inside the delivery area.
const covers = (chef, city, area, { strict = false } = {}) => {
    const areas = ((chef.kitchen && chef.kitchen.deliveryAreas) || []).map(norm);
    const c = norm(city), a = norm(area);
    const home = norm(chef.serviceLocation && chef.serviceLocation.city);
    if (!strict && !c && !a) return true; // browsing without typing a location: show every kitchen in the country
    const homeMatch = !!home && !!c && (home === c || home.includes(c) || c.includes(home));
    if (!areas.length) return homeMatch;
    if ((a && areas.includes(a)) || (c && areas.includes(c))) return true;
    return !strict && homeMatch && !a;
};

module.exports = { covers, norm };
