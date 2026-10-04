// Reviewed issuer relationships supplement provider IDs and imported groups.
// Alphabet lists GOOG and GOOGL as its two public share classes:
// https://abc.xyz/investor/ (Alphabet 2026 Q2 Form 10-Q).
const reviewedIssuer={GOOG:'0001652044',GOOGL:'0001652044'};
const cik=value=>typeof value==='string'&&/^\d{1,10}$/.test(value)?value.padStart(10,'0'):null;
export function sameReplacementIssuer(source,candidate,sourceProfile={},candidateProfile={}){
  if(source.relatedGroup&&source.relatedGroup===candidate.relatedGroup)return 'Same reviewed related-security group as source; excluded from replacement suggestions.';
  const a=reviewedIssuer[source.symbol],b=reviewedIssuer[candidate.symbol];
  if(a&&a===b)return 'Same issuer / alternate share class as source (Alphabet); excluded from replacement suggestions.';
  const x=cik(sourceProfile.cik)??a,y=cik(candidateProfile.cik)??b;
  if(x&&x===y)return 'Same issuer as source (matching SEC CIK); excluded from replacement suggestions.';
  return null;
}
