// ONE place that defines every supported country.
// To add a country: add an entry here, restart the server. Nothing else needs to change.
//
//  regionLabel/regionRequired : what the "state/county/province" field is called, and whether it is mandatory
//  postalLabel/postalRequired : same for ZIP / postcode
//  minHourlyRate              : in the country's own currency (PLACEHOLDER values - adjust to your market)
//  timezone                   : used for "is this date/time in the past?" checks
//                               (one zone per country; fine for KE/UG/TZ/..., approximate for US)
const COUNTRIES = {
    KE: { code: 'KE', name: 'Kenya', dialCode: '+254', currency: 'KES', locale: 'en-KE', timezone: 'Africa/Nairobi', decimals: 0,
          regionLabel: 'County', regionRequired: false, postalLabel: 'Postal code', postalRequired: false, minHourlyRate: 500 },
    UG: { code: 'UG', name: 'Uganda', dialCode: '+256', currency: 'UGX', locale: 'en-UG', timezone: 'Africa/Kampala', decimals: 0,
          regionLabel: 'District', regionRequired: false, postalLabel: 'Postal code', postalRequired: false, minHourlyRate: 15000 },
    TZ: { code: 'TZ', name: 'Tanzania', dialCode: '+255', currency: 'TZS', locale: 'en-TZ', timezone: 'Africa/Dar_es_Salaam', decimals: 0,
          regionLabel: 'Region', regionRequired: false, postalLabel: 'Postal code', postalRequired: false, minHourlyRate: 10000 },
    RW: { code: 'RW', name: 'Rwanda', dialCode: '+250', currency: 'RWF', locale: 'en-RW', timezone: 'Africa/Kigali', decimals: 0,
          regionLabel: 'Province', regionRequired: false, postalLabel: 'Postal code', postalRequired: false, minHourlyRate: 8000 },
    NG: { code: 'NG', name: 'Nigeria', dialCode: '+234', currency: 'NGN', locale: 'en-NG', timezone: 'Africa/Lagos', decimals: 0,
          regionLabel: 'State', regionRequired: true, postalLabel: 'Postal code', postalRequired: false, minHourlyRate: 8000 },
    ZA: { code: 'ZA', name: 'South Africa', dialCode: '+27', currency: 'ZAR', locale: 'en-ZA', timezone: 'Africa/Johannesburg', decimals: 2,
          regionLabel: 'Province', regionRequired: true, postalLabel: 'Postal code', postalRequired: true, minHourlyRate: 150 },
    GB: { code: 'GB', name: 'United Kingdom', dialCode: '+44', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', decimals: 2,
          regionLabel: 'County', regionRequired: false, postalLabel: 'Postcode', postalRequired: true, minHourlyRate: 15 },
    US: { code: 'US', name: 'United States', dialCode: '+1', currency: 'USD', locale: 'en-US', timezone: 'America/New_York', decimals: 2,
          regionLabel: 'State', regionRequired: true, postalLabel: 'ZIP code', postalRequired: true, minHourlyRate: 20 }
};

const DEFAULT_COUNTRY = 'KE';

const getCountry = (code) => COUNTRIES[String(code || DEFAULT_COUNTRY).toUpperCase()] || null;

module.exports = { COUNTRIES, DEFAULT_COUNTRY, getCountry };
