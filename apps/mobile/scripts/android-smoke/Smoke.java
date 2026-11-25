package ir.betterbuy.gosmoke;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.SystemClock;
import mobileengine.Mobileengine;
import mobileengine.Engine;
import org.json.JSONObject;
import org.json.JSONArray;

public final class Smoke extends Instrumentation {
 @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
 private static void check(boolean ok,String msg){if(!ok)throw new AssertionError(msg);}
 private static JSONObject waitState(Engine engine,String state) throws Exception {
  long end=SystemClock.elapsedRealtime()+5000;
  while(SystemClock.elapsedRealtime()<end){
   JSONObject row=new JSONObject(engine.status());
   if(row.getString("state").equals(state))return row;
   SystemClock.sleep(30);
  }
  throw new AssertionError("state "+state);
 }
 @Override public void onStart(){
  Bundle result=new Bundle();
  try {
   Engine engine=Mobileengine.new_();
   check("0.1.0".equals(engine.version()),"engine version");
   for (int i=0;i<100;i++) engine.status();
   long bridgeStarted=SystemClock.elapsedRealtimeNanos();
   for (int i=0;i<2000;i++) check(!engine.status().isEmpty(),"status");
   long statusNs=(SystemClock.elapsedRealtimeNanos()-bridgeStarted)/2000;
   check("OK".equals(engine.start()),"initial start");
   check("BUSY".equals(engine.start()),"exclusive start");
   JSONObject running=waitState(engine,"running");
   engine.cancel();
   JSONObject cancelled=waitState(engine,"cancelled");
   check(cancelled.getString("id").equals(running.getString("id")) && !cancelled.has("offers"),"cancellation correlation and offers");
   check("OK".equals(engine.start()),"second start");
   int maxRunning=0;
   JSONObject row;
   do {
    row=new JSONObject(engine.status());
    if(row.getString("state").equals("running")) maxRunning=Math.max(maxRunning,row.getInt("progress"));
    SystemClock.sleep(40);
   } while(row.getString("state").equals("running"));
   check("complete".equals(row.getString("state"))&&maxRunning>0&&row.getInt("progress")==3,"progress and completion");
   check(row.getInt("requests")==0,"fixture made network requests");
   JSONArray offers=row.getJSONArray("offers");
   check(offers.length()==2&&offers.getJSONObject(0).getInt("price")==800&&offers.getJSONObject(1).getInt("price")==900,"normalized offers");
   check("FIXTURE_ERROR".equals(engine.controlledError()),"error");
   String logs=engine.logs();
   JSONArray events=new JSONArray(logs);
   boolean correlated=false;
   for(int i=0;i<events.length();i++)if(row.getString("id").equals(events.getJSONObject(i).optString("scanId")))correlated=true;
   check(correlated,"log correlation");
   for(int i=0;i<40;i++)engine.controlledError();
   check(new JSONArray(engine.logs()).length()==32,"log bound");
   result.putString("stream","\nPASS Go JNI; duration_ms="+row.getInt("durationMs")+"; progress_observed="+maxRunning+"; log_bytes="+logs.getBytes(java.nio.charset.StandardCharsets.UTF_8).length+"; idle_status_mean_ns="+statusNs+"\n");
   finish(0,result);
  } catch(Throwable e){result.putString("stream","\nFAIL "+e+"\n");finish(1,result);}
 }
}
