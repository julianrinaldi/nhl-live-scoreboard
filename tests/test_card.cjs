"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,"../custom_components/nhl_live_scoreboard/nhl-live-game-card.js"),"utf8");

function harness() {
  const timers = new Map(), intervals = new Map(), fetches = [];
  const elements = new Map([["mlb-live-game-card",class {}],["nfl-live-game-card",class {}]]);
  let serial = 0;
  const context = {
    console:{info(){},debug(){}},HTMLElement:class {},Element:class {},URL,window:{},
    customElements:{get:name=>elements.get(name),define:(name,value)=>elements.set(name,value)},
    setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{const id=++serial;intervals.set(id,{fn,delay});return id;},clearInterval:id=>intervals.delete(id),
    requestAnimationFrame(){},fetch:url=>{fetches.push(url);return Promise.reject(new Error("Offline fixture"));},
  };
  vm.createContext(context);
  vm.runInContext(source+"\nglobalThis.api={Card:NhlLiveGameCard,CARD_DEFAULTS,CARD_CSS,EDITOR_SCHEMA,findNhlEntity,deepActiveElement,periodLabel,renderSituationRow,renderStrengthRow,renderRink,renderScoringPlaysPanel,renderRecentPlays,teamStatsTablesHtml,playerCardBodyHtml,goalieLines};",context);
  return {...context.api,context,timers,intervals,elements,fetches};
}

// Simulated live checkpoint using identities/stat keys from real NYR-DAL fixture.
function fixture() {
  return {
    league:"NHL",team_id:"13",team_abbr:"NYR",team_name:"New York Rangers",
    display_event_id:"401803619",previous_event_id:"401803618",mode:"live",is_live:true,
    competition:{id:"401803619",date:"2099-04-11T21:00:00Z",season:2026,seasonType:2,
      status:{period:3,displayClock:"7:11",type:{state:"in",name:"STATUS_IN_PROGRESS"}},
      competitors:[
        {homeAway:"away",team:{id:"13",name:"Rangers",abbreviation:"NYR"},score:"0",recordSummary:"33-38-9",linescores:[{displayValue:"0"},{displayValue:"0"},{displayValue:"0"}]},
        {homeAway:"home",team:{id:"9",name:"Stars",abbreviation:"DAL"},score:"1",recordSummary:"48-20-12",linescores:[{displayValue:"0"},{displayValue:"0"},{displayValue:"1"}]},
      ]},
    away_team:{id:"13",name:"Rangers",abbreviation:"NYR"},home_team:{id:"9",name:"Stars",abbreviation:"DAL"},
    period_context:{period:3,display_clock:"7:11",display_period:"3rd",is_intermission:false,is_shootout:false},
    situation:{away_shots_on_goal:20,home_shots_on_goal:18,strength:"Power Play",power_play_team_id:"9",away_empty_net:false,home_empty_net:false},
    goalies:{
      away:{id:"3151297",display_name:"Igor Shesterkin",short_name:"I. Shesterkin",headshot:"https://example.test/igor.png",game_stats:{saves:"17",shots_against:"18",goals_against:"1",save_percentage:".944"}},
      home:{id:"4196914",display_name:"Jake Oettinger",short_name:"J. Oettinger",game_stats:{saves:"20",shots_against:"20",goals_against:"0",save_percentage:"1.000"}},
    },
    current_period:{id:"3",number:3,label:"3rd",play_count:30,goals:1,away_goals:0,home_goals:1,is_current:true},
    recent_plays:[{id:"goal1",text:"Jason Robertson Goal, assists: Matt Duchene.",period:3,clock:"12:49",team_id:"9",scoring_play:true,score_value:1,away_score:0,home_score:1,is_shot:true,coordinate:{x:-81,y:-8},strength:"Power Play"}],
    leaders:{away:[{id:"3151297",name:"Igor Shesterkin",category:"Saves",value:"17"}],home:[]},
    team_stats:{away:{team_id:"13",name:"Rangers",categories:[{name:"goalies",label:"Goalies",columns:["SV","SV%"],keys:["saves","savePct"],rows:[{id:"3151297",name:"Igor Shesterkin",position:"G",stats:["17",".944"]}],totals:[]}]},home:{team_id:"9",name:"Stars",categories:[]}},
  };
}
function cardFor(h,attrs=fixture(),config={}) {
  const card=new h.Card();card.content={innerHTML:"",contains:()=>true,querySelector:()=>null};card.card={};
  card._hass={states:{"sensor.nhl_live_scoreboard_nyr":{state:attrs.display_event_id,attributes:attrs}}};
  card.setConfig({entity:"sensor.nhl_live_scoreboard_nyr",...config});card.render();return card;
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

test("NHL element, cache, options and CSS coexist with MLB and NFL",()=>{
  const h=harness();for(const name of ["mlb-live-game-card","nfl-live-game-card","nhl-live-game-card","nhl-live-game-card-editor"])assert(h.elements.has(name));
  assert.equal(h.CARD_DEFAULTS.live_default_view,"collapsed");assert.equal(h.CARD_DEFAULTS.show_shot_chart,false);assert.equal(h.CARD_DEFAULTS.show_period_nav,true);
  assert(!Object.keys(h.CARD_DEFAULTS).some(k=>/quarterback|drive|timeout|field|batter|pitch|inning|diamond|on_deck/.test(k)));
  const selectors=h.CARD_CSS.match(/[^{}]+(?=\{)/g);assert(selectors.every(g=>g.split(",").every(s=>s.trim().startsWith("nhl-live-game-card "))));
});
test("renamed NFL sensor is never selected as an NHL sensor",()=>{
  const h=harness();const states={"sensor.football":{attributes:{league:"NFL",team_abbr:"NYG",display_event_id:"1",period_context:{}}},"sensor.hockey":{attributes:{league:"NHL",team_abbr:"NYR",display_event_id:"2",period_context:{}}}};
  assert.equal(h.findNhlEntity({states}),"sensor.hockey");delete states["sensor.hockey"];assert(!h.findNhlEntity({states}));
});
test("missing configuration, entity and off-season data have useful messages",()=>{
  const h=harness(),card=cardFor(h);card.setConfig({});card.render();assert.match(card.content.innerHTML,/choose an NHL Live Scoreboard entity/);
  card.setConfig({entity:"sensor.nope"});card.render();assert.match(card.content.innerHTML,/Entity not found/);
  assert.match(cardFor(h,{league:"NHL",team_abbr:"NYR",display_event_id:"",mode:"idle"}).content.innerHTML,/No NHL game is currently available/);
});
test("live view starts collapsed and loads goalie portraits only after expansion",()=>{
  const h=harness(),card=cardFor(h);assert.match(card.content.innerHTML,/aria-expanded="false"/);assert.doesNotMatch(card.content.innerHTML,/Shesterkin/);assert.equal(h.fetches.length,0);
  card._toggleLiveExpand();assert.match(card.content.innerHTML,/Shesterkin/);assert(h.fetches.length>0);
  assert.doesNotMatch(card.content.innerHTML,/Down:|To go:|Ball on:|YDS|Quarterback|Touchdown/);
  card._toggleLiveExpand();assert.doesNotMatch(card.content.innerHTML,/Shesterkin/);
});
test("clock, shots, strength and goalie-stat updates repaint",()=>{
  const h=harness(),a=fixture(),card=cardFor(h,a,{live_default_view:"expanded"});
  for(const change of [()=>a.period_context.display_clock="7:10",()=>a.situation.away_shots_on_goal=21,()=>a.situation.power_play_team_id="13",()=>a.goalies.away.game_stats.saves="18"]){const before=card.content.innerHTML;change();card.render();assert.notEqual(card.content.innerHTML,before);}
  assert.match(card.content.innerHTML,/7:10/);
});
test("a new game resets live expansion",()=>{
  const h=harness(),a=fixture(),card=cardFor(h,a);card._toggleLiveExpand();a.display_event_id="401803620";a.competition.id=a.display_event_id;card.render();assert.match(card.content.innerHTML,/aria-expanded="false"/);
});
test("intermission shows actual leaders with no baseball or football copy",()=>{
  const h=harness(),a=fixture(),card=cardFor(h,a,{live_default_view:"expanded"});a.period_context.is_intermission=true;card.render();
  assert.match(card.content.innerHTML,/Intermission/);assert.match(card.content.innerHTML,/Game Leaders/);assert.match(card.content.innerHTML,/Saves/);assert.doesNotMatch(card.content.innerHTML,/Halftime|Due up|On Deck|Balls:|Strikes:|Outs:/);
});
test("NHL periods distinguish overtime from explicit shootout",()=>{
  const h=harness();assert.equal(h.periodLabel(3),"P3");assert.equal(h.periodLabel(4),"OT");assert.equal(h.periodLabel(5),"2OT");assert.equal(h.periodLabel(5,{is_shootout:true}),"SO");
  const a=fixture();a.period_context={period:5,is_shootout:true};a.competition.status.period=5;a.competition.status.type.detail="Shootout";
  assert.match(cardFor(h,a).content.innerHTML,/SO/);assert.doesNotMatch(cardFor(h,a).content.innerHTML,/2OT/);
});
test("real shootout linescore preserves official totals and labelsSO",()=>{
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,"fixtures/summary_401803626_shootout.json"),"utf8"));
  const h=harness(),a=fixture();a.competition=raw.header.competitions[0];a.period_context={period:5,is_shootout:true};a.is_live=false;a.mode="final";
  const card=cardFor(h,a);const html=card.renderLinescore(a.competition,null,a);
  assert.match(html,/>SO</);assert.doesNotMatch(html,/>2OT</);assert.match(html,/period-total">4</);assert.match(html,/period-total">3</);
});
for(const [name,file,period,shootout,suffix] of [
  ["regulation final keeps its date-only marker","summary_401803619_final.json",3,false,""],
  ["overtime final appends OT to its date marker","summary_401803625_overtime.json",4,false," · OT"],
  ["explicit shootout final appends SO to its date marker","summary_401803626_shootout.json",5,true," · SO"],
  ["playoff fifth period without shootout evidence appends 2OT","summary_401803625_overtime.json",5,false," · 2OT"],
]){
  test(name,()=>{
    const h=harness(),a=fixture();
    a.competition=JSON.parse(fs.readFileSync(path.join(__dirname,"fixtures",file),"utf8")).header.competitions[0];
    a.is_live=false;a.mode="final";
    a.period_context={period,is_shootout:shootout,display_clock:""};
    if(suffix===" · 2OT"){
      // Explicit synthetic playoff overtime; period 5 alone is never SO.
      a.competition.seasonType=3;a.competition.status.period=5;
      a.competition.status.type={state:"post",completed:true,name:"STATUS_FINAL",detail:"Final/2OT",shortDetail:"Final/2OT"};
    }
    const card=cardFor(h,a);
    const marker=card.content.innerHTML.match(/class="compact-date compact-final-date">([^<]*)<\/div>/);
    assert(marker);assert.equal(marker[1],card.formatCompactDateTime(a.competition.date).date+suffix);
    assert.match(card.content.innerHTML,/compact-mode/);
  });
}
test("status-only final metadata changes repaint the compact overtime marker",()=>{
  const h=harness(),a=fixture();a.is_live=false;a.mode="final";a.period_context={};
  a.competition.status={period:3,type:{state:"post",completed:true,name:"STATUS_FINAL",detail:"Final"}};
  const card=cardFor(h,a),date=card.formatCompactDateTime(a.competition.date).date;
  const marker=()=>card.content.innerHTML.match(/class="compact-date compact-final-date">([^<]*)<\/div>/)[1];
  assert.equal(marker(),date);
  a.competition.status={period:4,type:{state:"post",completed:true,name:"STATUS_FINAL_OT",detail:"Final/OT"}};
  card.render();assert.equal(marker(),date+" · OT");
  a.competition.status={period:5,type:{state:"post",completed:true,name:"STATUS_FINAL_SO",detail:"Final/SO"}};
  card.render();assert.equal(marker(),date+" · SO");
});
test("historical linescore uses the earlier checkpoint and hides later periods",()=>{
  const h=harness(),a=fixture(),card=cardFor(h,a);
  const html=card.renderLinescore(a.competition,{period_context:{period:2},away_score:0,home_score:0},a);
  assert.match(html,/period-total">0</);assert.doesNotMatch(html,/period-cell">1</);
});
test("unknown shots and strength stay unknown; valid zero shots render",()=>{
  const h=harness();assert.match(h.renderSituationRow({away_shots_on_goal:0,home_shots_on_goal:0}),/>0</);assert.match(h.renderSituationRow({}),/—/);
  assert.doesNotMatch(h.renderStrengthRow({situation:{}}),/Even Strength|5.?on.?5|EMPTY NET|Power Play/i);
  assert.doesNotMatch(h.renderRink({situation:{}},[],false),/football|possession|puck position/i);
});
test("global power play and empty net flags do not assign them to a team",()=>{
  const h=harness(),a=fixture();a.situation={power_play:true,empty_net:true};
  const html=h.renderStrengthRow(a);assert.match(html,/Power play/i);assert.match(html,/Empty net/i);assert.doesNotMatch(html,/class="nhl-power-play"|class="nhl-empty-net"/);
});
test("shot chart plots verified rink coordinates but rejects invalid or shootout locations",()=>{
  const h=harness(),a=fixture();
  const plays=[...a.recent_plays,{is_shot:true,coordinate:{x:101,y:0},text:"Outside rink"},{is_shot:true,coordinate:{x:0,y:43},text:"Outside boards"},{is_shot:true,coordinate:{x:true,y:0},text:"Boolean coordinate"},{is_shot:true,coordinate:{x:0,y:NaN},text:"Invalid coordinate"},{is_shot:true,is_shootout:true,coordinate:{x:80,y:0},text:"Shootout attempt"},{is_shot:false,coordinate:{x:0,y:0},text:"Period boundary"}];
  const html=h.renderRink(a,plays,true);assert.equal((html.match(/class="nhl-rink-play/g)||[]).length,1);assert.match(html,/1 shot locations/);assert.match(html,/cx="22\.24"/);assert.doesNotMatch(html,/Outside rink|Outside boards|Boolean coordinate|Invalid coordinate|Shootout attempt|Period boundary/);
  assert.match(h.renderRink(a,[],true),/Shot locations unavailable/);
});
test("goalie stats use saves and goals against, never football statistics",()=>{
  const h=harness(),line=h.goalieLines(fixture().goalies.away,false);assert.match(line.primary+line.secondary,/17/);assert.match(line.primary+line.secondary,/\.944/);assert.doesNotMatch(line.primary+line.secondary,/YDS|TD|INT|RTG/);
});
test("compact final and pregame remain expandable without inventing starting goalies",()=>{
  const h=harness(),a=fixture();a.is_live=false;a.mode="final";a.competition.status.type={state:"post",completed:true,name:"STATUS_FINAL"};
  const card=cardFor(h,a);assert.match(card.content.innerHTML,/compact-mode/);card._upcomingExpanded=true;card._lastFingerprint="";card._lastCompactFp="";card.render();assert.match(card.content.innerHTML,/Game Leaders/);
  a.mode="next";a.competition.status.type={state:"pre",name:"STATUS_SCHEDULED"};a.goalies={away:{},home:{}};card._lastFingerprint="";card.render();assert.doesNotMatch(card.content.innerHTML,/Shesterkin|Projected QB/);
});
test("postponed and delayed games do not masquerade as final zero-zero",()=>{
  const h=harness(),a=fixture();a.is_live=false;a.competition.status.type={state:"post",completed:false,name:"STATUS_POSTPONED"};const card=cardFor(h,a);assert.match(card.content.innerHTML,/PPD/);assert.doesNotMatch(card.content.innerHTML,/final-score/);
  a.is_delayed=true;a.competition.status.type={state:"in",name:"STATUS_DELAYED",detail:"Delayed"};card.render();assert.match(card.content.innerHTML,/Delayed/);
});
test("goal summaries use periods and escaped ESPN descriptions",()=>{
  const h=harness(),a=fixture();a.scoring_plays=[{period_number:1,clock:"8:02",team_id:"13",away_score:1,home_score:0,text:"Goal <script>alert(1)</script>"},{period_number:4,away_score:2,home_score:1,text:"Overtime goal"}];
  const html=h.renderScoringPlaysPanel(a,a.away_team,a.home_team);assert.match(html,/>P1</);assert.match(html,/>OT</);assert.match(html,/1-0/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test("shootout attempts show SO and never null-null game totals",()=>{
  const h=harness();const html=h.renderRecentPlays([{period:5,is_shootout:true,scoring_play:true,score_value:0,away_score:null,home_score:null,text:"Shootout goal"}],h.CARD_DEFAULTS);
  assert.match(html,/SO/);assert.doesNotMatch(html,/null-null|2OT|0-0/);
});
test("a full period retains every play in a keyboard-scrollable newest-first list without mutating input",()=>{
  const h=harness();const plays=Array.from({length:94},(_,i)=>({id:String(i),period:2,text:"Play number "+String(i).padStart(2,"0")}));
  const before=JSON.stringify(plays);const html=h.renderRecentPlays(plays,h.CARD_DEFAULTS);
  assert.equal((html.match(/class="play-row"/g)||[]).length,94);assert(html.indexOf("Play number93")<html.indexOf("Play number00") || html.indexOf("Play number 93")<html.indexOf("Play number 00"));
  assert.equal(JSON.stringify(plays),before);assert.match(html,/tabindex="0"/);assert.match(html,/role="region"/);assert.match(html,/aria-label=/);
  assert.match(h.CARD_CSS,/\.plays-panel[^}]*max-height:\s*320px/);assert.match(h.CARD_CSS,/\.plays-panel[^}]*overflow-y:\s*auto/);
});
test("live repaint preserves play-list reading position and keyboard focus within one period",()=>{
  const h=harness(),a=fixture(),card=cardFor(h,a,{live_default_view:"expanded"});
  const oldPanel=new h.context.HTMLElement(),newPanel=new h.context.HTMLElement();oldPanel.scrollTop=120;oldPanel.scrollHeight=500;newPanel.scrollHeight=550;newPanel.scrollTop=0;
  let focused=0;newPanel.focus=options=>{assert.equal(options.preventScroll,true);focused++;h.context.document.activeElement=newPanel;};
  h.context.document={activeElement:oldPanel};let panel=oldPanel,html=card.content.innerHTML;
  card.content.querySelector=selector=>selector===".plays-panel"?panel:null;
  Object.defineProperty(card.content,"innerHTML",{get:()=>html,set:value=>{html=value;panel=newPanel;}});
  a.period_context.display_clock="7:10";card.render();assert.equal(newPanel.scrollTop,170);assert.equal(focused,1);
  a.period_context.period=4;a.period_context.display_clock="4:59";card.render();assert.equal(newPanel.scrollTop,0);
});
test("game and season statistics match machine keys and leave missing values blank",()=>{
  const h=harness(),team=fixture().team_stats.away;assert.match(h.teamStatsTablesHtml(team,"game",{}),/\.944/);
  const season={"3151297":{categories:{goalies:{columns:["SV%","SV"],keys:["savePct","saves"],stats:[".912","1299"]}}}};
  const html=h.teamStatsTablesHtml(team,"season",season);assert.match(html,/1299/);assert.match(html,/\.912/);assert.match(h.teamStatsTablesHtml(team,"season",{}),/—/);
});
test("season tables label actual years and do not reuse game tooltip descriptions",()=>{
  const h=harness(),team=fixture().team_stats.away;team.categories[0].descriptions=["Game saves","Game percentage"];
  const season={"3151297":{season:"25-26",categories:{goalies:{columns:["SV"],keys:["saves"],stats:["1299"],descriptions:["Season saves"]}}}};
  let html=h.teamStatsTablesHtml(team,"season",season);assert.match(html,/25-26 season/);assert.match(html,/title="Season saves"/);assert.doesNotMatch(html,/title="Game saves"/);
  team.categories[0].rows.push({id:"2",name:"Other Goalie",stats:[]});season["2"]={season:"24-25",categories:{goalies:{columns:["SV"],keys:["saves"],stats:["500"]}}};
  html=h.teamStatsTablesHtml(team,"season",season);assert.match(html,/Latest available seasons/);assert.match(html,/>Season</);assert.match(html,/24-25/);
});
test("career popup handles goalie categories and escapes labels",()=>{
  const h=harness();const html=h.playerCardBodyHtml({bio:{team:"Rangers",position:"G"},career:{label:"Goaltending <x>",columns:["SV"],seasons:[{year:"2026",team:"NYR",stats:["1299"]}],totals:["7000"]}});
  assert.match(html,/Goaltending &lt;x&gt;/);assert.match(html,/1299/);assert.doesNotMatch(html,/Batting|Pitching|B\/T|Passing/);
});
test("schedule navigation uses NHL route and returns after60 seconds",async()=>{
  const h=harness(),card=cardFor(h),calls=[],neighbor=fixture();neighbor.display_event_id="401803620";neighbor.is_live=false;neighbor.mode="next";neighbor.competition.status.type={state:"pre",name:"STATUS_SCHEDULED"};
  card._hass.connection={sendMessagePromise:async r=>{calls.push(r);return {offset:1,game_data:neighbor,has_prev:true,has_next:false};}};card._navigateSchedule(1);await tick();assert.equal(calls[0].type,"nhl_live_scoreboard/game_at_offset");assert.equal(card._navOffset,1);
  const timer=[...h.timers.values()].find(t=>t.delay===60000);assert(timer);timer.fn();assert.equal(card._navOffset,0);
});
test("stale schedule responses cannot replace a new selection",async()=>{
  const h=harness(),card=cardFor(h);let resolve;card._hass.connection={sendMessagePromise:()=>new Promise(r=>{resolve=r;})};card._navigateSchedule(1);card._resetScheduleNav();resolve({offset:1,game_data:fixture()});await tick();assert.equal(card._navOffset,0);assert.equal(card._navGameData,null);
});
test("period pager rolls back clocks and scores and returns after20 seconds",async()=>{
  const h=harness(),card=cardFor(h,fixture(),{live_default_view:"expanded"}),calls=[];
  card._hass.connection={sendMessagePromise:async r=>{calls.push(r);return {offset:-1,total_periods:3,is_current:false,has_prev:true,has_next:true,away_score:0,home_score:0,period_context:{period:2,display_clock:"0:00"},current_period:{id:"2",number:2,label:"2nd",play_count:30,goals:0},recent_plays:[{id:"old",period:2,clock:"19:58",text:"Earlier shot saved",away_score:0,home_score:0}]};}};
  card._navigatePeriod(-1);await tick();assert.equal(calls[0].type,"nhl_live_scoreboard/period_at_offset");assert.match(card.content.innerHTML,/Earlier period/);assert.match(card.content.innerHTML,/Earlier shot saved/);assert.doesNotMatch(card.content.innerHTML,/\.944/);
  const timer=[...h.timers.values()].find(t=>t.delay===20000);assert(timer);timer.fn();assert.equal(card._periodOffset,0);assert.match(card.content.innerHTML,/7:11/);
});
test("an earlier period with an explicit blank countdown never inherits the live clock",async()=>{
  const h=harness(),a=fixture();
  a.period_context.display_clock="5:00";a.competition.status.displayClock="5:00";
  const card=cardFor(h,a,{live_default_view:"expanded"});
  assert.match(card.content.innerHTML,/5:00/);
  card._hass.connection={sendMessagePromise:async()=>({
    offset:-1,total_periods:3,is_current:false,has_prev:true,has_next:true,
    away_score:0,home_score:0,
    period_context:{period:2,display_clock:"",display_period:"2nd"},
    current_period:{id:"2",number:2,label:"2nd",play_count:1,goals:0},
    recent_plays:[{id:"earlier",period:2,clock:"19:58",text:"Earlier shot saved"}],
  })};
  card._navigatePeriod(-1);await tick();
  assert.equal(card._periodOffset,-1);
  assert.match(card.content.innerHTML,/Earlier period · P2<\/div>/);
  assert.doesNotMatch(card.content.innerHTML,/5:00/);
  assert.match(card.content.innerHTML,/19:58/);
  card._navigatePeriod(1);
  assert.equal(card._periodOffset,0);
  assert.doesNotMatch(card.content.innerHTML,/Earlier period/);
  assert.match(card.content.innerHTML,/5:00/);
});
test("an earlier regulation period explicitly opts out of the live shootout context",async()=>{
  const h=harness(),a=fixture();
  a.period_context={period:5,display_clock:"",display_period:"SO",is_shootout:true};
  a.competition.status={period:5,displayClock:"0:00",type:{state:"in",name:"STATUS_SHOOTOUT",detail:"Shootout",shortDetail:"Final/SO"}};
  const card=cardFor(h,a,{live_default_view:"expanded"});
  assert.match(card.content.innerHTML,/>SO</);
  card._hass.connection={sendMessagePromise:async()=>({
    offset:-2,total_periods:5,is_current:false,has_prev:true,has_next:true,
    away_score:1,home_score:1,
    period_context:{period:3,display_clock:"",display_period:"3rd",is_shootout:false},
    current_period:{id:"3",number:3,label:"3rd",play_count:1,goals:0,is_shootout:false},
    recent_plays:[{id:"earlier",period:3,clock:"19:58",text:"Earlier shot saved",is_shootout:false}],
  })};
  card._navigatePeriod(-2);await tick();
  assert.equal(card._periodOffset,-2);
  assert.match(card.content.innerHTML,/Earlier period · P3<\/div>/);
  assert.doesNotMatch(card.content.innerHTML,/>SO</);
  card._navigatePeriod(2);
  assert.equal(card._periodOffset,0);
  assert.match(card.content.innerHTML,/>SO</);
});
test("stale period responses are discarded after resets",async()=>{
  const h=harness(),card=cardFor(h);let resolve;card._hass.connection={sendMessagePromise:()=>new Promise(r=>{resolve=r;})};card._navigatePeriod(-1);card._resetPeriodNav();resolve({offset:-1,recent_plays:[],current_period:{id:"old"}});await tick();assert.equal(card._periodOffset,0);assert.equal(card._periodView,null);
});
test("configuration edits invalidate memoized compact markup",()=>{
  const h=harness(),a=fixture();a.is_live=false;a.mode="next";a.competition.status.type={state:"pre",name:"STATUS_SCHEDULED"};const card=cardFor(h,a);assert.match(card.content.innerHTML,/schedule-nav-btn/);card.setConfig({entity:"sensor.nhl_live_scoreboard_nyr",show_schedule_nav:false});card.render();assert.doesNotMatch(card.content.innerHTML,/schedule-nav-btn/);
});
test("profile and team-season requests deduplicate and cache",async()=>{
  const h=harness(),card=cardFor(h),calls=[];card._hass.connection={sendMessagePromise:async r=>{calls.push(r);return r.type.endsWith("player_card")?{player_card:{bio:{name:"Igor Shesterkin"}}}:{season_stats:{"3151297":{season:2026,categories:{}}}};}};
  await Promise.all([card._fetchPlayerCard("3151297"),card._fetchPlayerCard("3151297")]);await card._fetchPlayerCard("3151297");assert.equal(calls.length,1);
  await Promise.all([card._fetchTeamSeasonStats("away"),card._fetchTeamSeasonStats("away")]);await card._fetchTeamSeasonStats("away");assert.equal(calls.length,2);assert.equal(calls[1].type,"nhl_live_scoreboard/team_season_stats");assert.deepEqual(Array.from(calls[1].athlete_ids),["3151297"]);
});
test("disconnect clears navigation and timers; reconnect rearms local refresh",()=>{
  const h=harness(),card=cardFor(h,fixture(),{refresh_rate:10});card._navOffset=2;card._navGameData=fixture();card._periodOffset=-1;card._periodView={recent_plays:[]};card._armNavIdleTimer();card._armPeriodIdleTimer();card._setupRefreshTimer();const nav=card._navGeneration,period=card._periodGeneration;
  card.disconnectedCallback();assert.equal(card._navOffset,0);assert.equal(card._periodOffset,0);assert.equal(h.timers.size,0);assert.equal(h.intervals.size,0);assert(card._navGeneration>nav);assert(card._periodGeneration>period);card.hass=card._hass;assert.equal(h.intervals.size,1);
});
test("native highlight anchors retain normal click and keyboard activation",()=>{
  const h=harness(),card=cardFor(h),anchor=new h.context.Element();anchor.closest=s=>s.includes("a[href]")?anchor:null;let prevented=0;const event={target:anchor,key:"Enter",preventDefault(){prevented++;},stopPropagation(){}};card._onContentClick(event);card._onContentKeydown(event);event.key=" ";card._onContentKeydown(event);assert.equal(prevented,0);
});
test("keyboard player activation happens once, without doubling native buttons",()=>{
  const h=harness(),card=cardFor(h),link=new h.context.Element();link.closest=s=>s===".player-link"?link:null;let opened=0;card._openPlayerProfile=()=>{opened++;return true;};card._onContentKeydown({target:link,key:"Enter",preventDefault(){}});assert.equal(opened,1);const button=new h.context.Element();button.closest=s=>s.includes("button")?button:null;card._onContentKeydown({target:button,key:"Enter",preventDefault(){}});assert.equal(opened,1);
});
test("popup focus traverses HA shadow roots and restores replaced openers",()=>{
  const h=harness(),card=cardFor(h),leaf=new h.context.HTMLElement();h.context.document={activeElement:{shadowRoot:{activeElement:{shadowRoot:{activeElement:leaf}}}},body:{style:{overflow:"hidden"}}};assert.equal(h.deepActiveElement(),leaf);let focused=0;const replacement={getAttribute:()=>"3151297",focus(){focused++;}};card.isConnected=true;card.content.querySelectorAll=()=>[replacement];card.content.querySelector=()=>null;card._pcOverlay={hidden:false};card._pcReturnFocus={isConnected:false};card._pcFocusAthleteId="3151297";card._closePlayerCardPopup();assert.equal(focused,1);assert.equal(h.context.document.body.style.overflow,"");
});
